'use strict'
const { withTx }=require('./tx')
const { httpError }=require('./errors')
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function deriveBatchState(batch,counts){
  const received=counts.waiting+counts.processing+counts.done+counts.partial+counts.failed+counts.cancelled
  const terminal=counts.done+counts.partial+counts.failed+counts.cancelled
  let state=batch.control==='paused'?'paused':batch.control==='cancelled'?'cancelling':batch.sealed_at?'running':'accepting'
  if(batch.sealed_at&&terminal===received){
    const incomplete=received<batch.expected_count
    state=counts.cancelled?'cancelled':counts.failed===received&&received&&!incomplete?'failed':counts.partial||counts.failed||incomplete?'partial':'done'
  }
  return {state,received,notUploaded:Math.max(0,batch.expected_count-received),completed:terminal,progress:batch.expected_count?terminal/batch.expected_count:0}
}
function createBatches(pool,queue) {
  function allowed(user){if(Array.isArray(user.scopeFolderIds))throw httpError(403,'batch_scope_unsupported','Use a session or unscoped token for batch administration')}
  async function load(db,user,id,lock=false){allowed(user);if(!UUID.test(id))throw httpError(404,'missing');const r=await db.query(`select * from kb.batches where id=$1 and owner_id=$2${lock?' for update':''}`,[id,user.id]);if(!r.rows[0])throw httpError(404,'missing');return r.rows[0]}
  async function create(user,body){allowed(user);const n=Number(body.expectedCount);if(!Number.isInteger(n)||n<1||n>1000)throw httpError(400,'bad_batch_size');const b=(await pool.query('insert into kb.batches(owner_id,name,expected_count) values($1,$2,$3) returning id',[user.id,String(body.name||'').slice(0,200),n])).rows[0];return status(user,b.id)}
  async function list(user,{cursor='',limit=25}={}){allowed(user);if(cursor&&!UUID.test(cursor))throw httpError(400,'bad_cursor');const cap=Math.max(1,Math.min(100,Number(limit)||25));const rows=(await pool.query('select id from kb.batches where owner_id=$1 and ($2::uuid is null or id>$2::uuid) order by id limit $3',[user.id,cursor||null,cap+1])).rows;return {items:await Promise.all(rows.slice(0,cap).map(r=>status(user,r.id))),nextCursor:rows.length>cap?rows[cap-1].id:null}}
  async function status(user,id){const b=await load(pool,user,id);const r=await pool.query('select state,count(*)::int n from kb.batch_items where batch_id=$1 group by state',[id]);const counts={waiting:0,processing:0,done:0,partial:0,failed:0,cancelled:0};for(const x of r.rows)counts[x.state]=x.n;const derived=deriveBatchState(b,counts);
    return {id:b.id,name:b.name,state:derived.state,control:b.control,sealed:!!b.sealed_at,total:b.expected_count,received:derived.received,notUploaded:derived.notUploaded,...counts,completed:derived.completed,progress:derived.progress,createdAt:b.created_at,updatedAt:b.updated_at}
  }
  async function attach(db,user,id,{file,runId,duplicate,clientKey,name,metrics}){
    const b=await load(db,user,id,true);if(b.control==='cancelled')throw httpError(409,'batch_closed');
    const run=runId?(await db.query('select status from kb.parse_runs where id=$1 for update',[runId])).rows[0]:null
    const itemState=duplicate&&run&&['done','partial','failed'].includes(run.status)?run.status:'waiting'
    const old=await db.query('select * from kb.batch_items where batch_id=$1 and client_key=$2',[id,clientKey]);
    if(b.sealed_at && !(old.rows[0] && (old.rows[0].file_id===file.id || (old.rows[0].file_id==null && old.rows[0].state==='failed'))))throw httpError(409,'batch_closed');
    if(old.rows[0]){
      if(old.rows[0].file_id==null && old.rows[0].state==='failed')return (await db.query(`update kb.batch_items set file_id=$2,run_id=$3,state=$4,
        duplicate=$5,error=null,upload_metrics=$6,updated_at=now() where id=$1 returning *`,[old.rows[0].id,file.id,runId,itemState,duplicate,{...metrics,previousUploadError:old.rows[0].error}])).rows[0]
      if(old.rows[0].file_id!==file.id)throw httpError(409,'client_key_conflict');return old.rows[0]
    }
    const n=(await db.query('select count(*)::int n from kb.batch_items where batch_id=$1',[id])).rows[0].n;if(n>=b.expected_count)throw httpError(409,'batch_full')
    return (await db.query(`insert into kb.batch_items(batch_id,client_key,file_id,run_id,name,duplicate,state,upload_metrics)
      values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,[id,clientKey,file.id,runId,name,duplicate,itemState,metrics])).rows[0]
  }
  async function control(user,id,action){
    await withTx(pool,async c=>{const b=await load(c,user,id,true)
      // Same admission lock as claim: pause/cancel cannot race a new claim.
      await c.query("select pg_advisory_xact_lock(hashtext('kb.queue.admission'))")
      if(action==='seal'){await c.query('update kb.batches set sealed_at=coalesce(sealed_at,now()),updated_at=now() where id=$1',[id])}
      else if(action==='pause'||action==='resume'){if(b.control==='cancelled')throw httpError(409,'batch_cancelled');await c.query('update kb.batches set control=$2,updated_at=now() where id=$1',[id,action==='pause'?'paused':'running'])}
      else if(action==='cancel'){
        await c.query("update kb.batches set control='cancelled',sealed_at=coalesce(sealed_at,now()),updated_at=now() where id=$1",[id])
        // Never invalidate a running lease/transaction; cancel every unstarted phase.
        await c.query(`update kb.jobs set state='cancelled',updated_at=now() where batch_id=$1 and state='queued'
          `,[id])
        await c.query(`update kb.batch_items i set state='cancelled',updated_at=now() where batch_id=$1 and state in('waiting','processing')
          and (duplicate or not exists(select 1 from kb.jobs j where j.run_id=i.run_id and j.batch_id=$1 and j.state='running'))`,[id])
        await c.query(`update kb.parse_runs r set status='failed',error='cancelled_before_start',finished_at=now()
          where r.id in(select i.run_id from kb.batch_items i where i.batch_id=$1 and i.state='cancelled' and not i.duplicate)`,[id])
        await c.query(`update kb.files f set status=case when current_run_id is null then 'failed' else 'partial' end,
          status_detail='cancelled before start',error='cancelled_before_start',updated_at=now()
          where f.id in(select i.file_id from kb.batch_items i where i.batch_id=$1 and i.state='cancelled' and not i.duplicate)`,[id])
      }else if(action==='retry'){
        if(b.control==='cancelled')throw httpError(409,'batch_cancelled')
        const items=await c.query("select * from kb.batch_items where batch_id=$1 and state='failed' and not duplicate for update",[id])
        for(const i of items.rows){
          const jobs=await c.query("select * from kb.jobs where run_id=$1 and state='failed' order by id limit 1",[i.run_id]);if(!jobs.rows[0])continue
          const j=jobs.rows[0];await c.query('select id from kb.files where id=$1 for update',[i.file_id]);
          const latest=await c.query('select id from kb.parse_runs where file_id=$1 order by created_at desc,id desc limit 1',[i.file_id]);
          if(latest.rows[0]?.id!==i.run_id)throw httpError(409,'run_superseded')
          if((await c.query("select 1 from kb.jobs where file_id=$1 and state in('queued','running')",[i.file_id])).rows.length)throw httpError(409,'job_in_progress')
          // Same run/job, fresh lease on next claim; retain immutable attempt history.
          await c.query("update kb.jobs set state='queued',attempts=0,lease_token=null,locked_until=null,locked_by=null,run_after=now(),updated_at=now() where id=$1",[j.id])
          await c.query("update kb.parse_runs set status='queued',error=null,finished_at=null where id=$1",[i.run_id])
          await c.query("update kb.files set status='pending',error=null,updated_at=now() where id=$1",[i.file_id])
          await c.query("update kb.batch_items set state='waiting',error=null,updated_at=now() where id=$1",[i.id])
        }
      }else throw httpError(400,'bad_batch_action')
      await c.query('insert into kb.audit(actor,action,target) values($1,$2,$3)',[user.id,'batch.'+action,id])
    });return status(user,id)
  }
  async function items(user,id,{after='',limit=50}={}){await load(pool,user,id);if(after&&!UUID.test(after))throw httpError(400,'bad_cursor');const cap=Math.max(1,Math.min(200,Number(limit)||50));const r=await pool.query(`select * from kb.batch_items where batch_id=$1 and ($2::uuid is null or id>$2::uuid) order by id limit $3`,[id,after||null,cap+1]);return {items:r.rows.slice(0,cap),nextCursor:r.rows.length>cap?r.rows[cap-1].id:null}}
  async function metrics(user,id){await load(pool,user,id);return {items:(await pool.query(`select j.id,j.file_id,j.kind,j.resource_class,j.state,j.attempts,j.metrics,
      coalesce((select jsonb_agg(to_jsonb(a) order by a.id) from kb.job_attempts a where a.job_id=j.id),'[]') history
      from kb.jobs j where j.batch_id=$1 order by j.id`,[id])).rows}}
  async function reject(user,id,{key,name,error,uploadMetrics}){
    return withTx(pool,async c=>{const b=await load(c,user,id,true);if(b.sealed_at||b.control==='cancelled')throw httpError(409,'batch_closed');
      const old=(await c.query('select id from kb.batch_items where batch_id=$1 and client_key=$2',[id,key])).rows[0];if(old)return
      if((await c.query('select count(*)::int n from kb.batch_items where batch_id=$1',[id])).rows[0].n>=b.expected_count)throw httpError(409,'batch_full')
      await c.query("insert into kb.batch_items(batch_id,client_key,name,state,error,upload_metrics) values($1,$2,$3,'failed',$4,$5)",[id,key,name,error,uploadMetrics])
    })
  }
  return {create,list,status,load,attach,control,items,metrics,reject}
}
module.exports={createBatches,deriveBatchState}
