'use strict'
// PostgreSQL job queue for File KB.
//  - claim: FOR UPDATE SKIP LOCKED over queued jobs whose run_after has passed, plus
//    running jobs whose lease (locked_until) expired (crashed / hung worker => reclaimed).
//  - every claim mints a new lease_token (fencing token). All state changes made on
//    behalf of a job go through withFence(), which locks the job row and verifies
//    lease_token + state='running' + locked_until > now(). A stale worker whose lease
//    was lost/reclaimed therefore cannot commit anything.
//  - partial unique index kb_jobs_active_uq (file_id, kind) where state in (queued,running)
//    prevents duplicate active jobs.
const { withTx } = require('./tx')

class LeaseLostError extends Error {
  constructor(jobId) { super(`lease lost for job ${jobId}`); this.code = 'LEASE_LOST' }
}

function createQueue(pool, { workerId = `w-${process.pid}`, leaseMs = 600000, backoffBaseMs = 5000, maxConcurrent = 2, lightConcurrency = 2, heavyConcurrency = 1, formatConcurrency = {} } = {}) {
  function backoffMs(attempts) {
    return backoffBaseMs * Math.pow(4, Math.max(0, attempts - 1))
  }

  async function enqueue(db, { fileId, runId, kind, batchId = null, delayMs = 0, maxAttempts = 3 }) {
    const r = await db.query(
      `insert into kb.jobs (file_id, run_id, kind, run_after, max_attempts, batch_id, resource_class)
       select $1,$2,$3,now()+($4::bigint*interval '1 millisecond'),$5,
         coalesce($6::uuid,(select batch_id from kb.jobs where run_id=$2 order by id limit 1)),
         case when $3='structure' or ext in ('xlsx','md','csv') then 'light' else 'heavy' end from kb.files where id=$1
       on conflict (file_id, kind) where state in ('queued', 'running') do nothing
       returning id`, [fileId, runId, kind, delayMs, maxAttempts, batchId])
    return r.rows[0] ? r.rows[0].id : null
  }

  async function claim() {
    return withTx(pool, async c => {
      await c.query("select pg_advisory_xact_lock(hashtext('kb.queue.admission'))")
      const active = (await c.query("select resource_class,count(*)::int n from kb.jobs where state='running' and locked_until>now() group by resource_class")).rows
      const used = Object.fromEntries(active.map(r=>[r.resource_class,r.n]))
      if ((used.light||0)+(used.heavy||0)>=maxConcurrent) return null
      const picked = await c.query(`select j.* from kb.jobs j join kb.files f on f.id=j.file_id left join kb.batches b on b.id=j.batch_id
        where ((j.state='queued' and j.run_after<=now()) or (j.state='running' and j.locked_until<now()))
        and ((j.resource_class='light' and $1) or (j.resource_class='heavy' and $2))
        and (j.kind<>'parse' or not exists(select 1 from jsonb_each_text($3::jsonb) lim where lim.key=f.ext and
          (select count(*) from kb.jobs a join kb.files af on af.id=a.file_id
           where a.kind='parse' and a.state='running' and a.locked_until>now() and af.ext=f.ext)>=lim.value::int))
        and (b.id is null or b.control='running' or j.state='running')
        order by (j.state='running') desc,(j.kind='structure') desc,j.run_after,j.id
        for update of j skip locked limit 1`,[(used.light||0)<lightConcurrency,(used.heavy||0)<heavyConcurrency,JSON.stringify(formatConcurrency)])
      if(!picked.rows[0]) return null
      const old=picked.rows[0]
      if(old.state==='running')await c.query("update kb.job_attempts set outcome='lease_expired',finished_at=now() where job_id=$1 and finished_at is null",[old.id])
      const r=await c.query(`update kb.jobs set state='running',attempts=attempts+1,locked_by=$2,
        locked_until=now()+($3::bigint*interval '1 millisecond'),lease_token=gen_random_uuid(),
        first_started_at=coalesce(first_started_at,now()),updated_at=now() where id=$1 returning *`,[old.id,workerId,leaseMs])
      const job=r.rows[0]
      job.queue_entered_at=old.updated_at
      await c.query('insert into kb.job_attempts(job_id,lease_token,attempt,worker_id) values($1,$2,$3,$4)',[job.id,job.lease_token,job.attempts,workerId])
      await c.query("update kb.batch_items set state='processing',updated_at=now() where run_id=$1 and state='waiting'",[job.run_id])
      return job
    })
  }

  async function heartbeat(job) {
    const r = await pool.query(
      `update kb.jobs set locked_until = now() + ($3::bigint * interval '1 millisecond'), updated_at = now()
       where id = $1 and lease_token = $2 and state = 'running' and locked_until > now()
       returning id`, [job.id, job.lease_token, leaseMs])
    return r.rowCount === 1
  }

  async function lockFence(client, job) {
    const r = await client.query(
      `select id from kb.jobs where id = $1 and lease_token = $2 and state = 'running'
         and locked_until > now() for update`, [job.id, job.lease_token])
    if (!r.rows[0]) throw new LeaseLostError(job.id)
  }

  // Run fn inside a transaction that holds the fenced job row lock.
  async function withFence(job, fn) {
    return withTx(pool, async client => {
      await lockFence(client, job)
      return fn(client)
    })
  }

  async function complete(client, job) {
    await client.query(
      `update kb.jobs set state = 'done', locked_by = null, locked_until = null,
         lease_token = null, last_error = null, updated_at = now() where id = $1`, [job.id])
  }

  // Returns { final } ; final=true means attempts exhausted and job is now failed.
  async function retry(client, job, err) {
    const msg = String((err && err.message) || err).slice(0, 2000)
    const final = err && err.retryable === false ? true : job.attempts >= job.max_attempts
    if (final) {
      await client.query(
        `update kb.jobs set state = 'failed', locked_by = null, locked_until = null, lease_token = null,
           last_error = $2, updated_at = now() where id = $1`, [job.id, msg])
    } else {
      await client.query(
        `update kb.jobs set state = 'queued', locked_by = null, locked_until = null, lease_token = null,
           last_error = $2, run_after = now() + ($3::bigint * interval '1 millisecond'), updated_at = now()
         where id = $1`, [job.id, msg, backoffMs(job.attempts)])
    }
    return { final }
  }

  // Dependency unavailable (docling down / breaker open): put back WITHOUT consuming an attempt.
  async function defer(client, job, delayMs, reason) {
    await client.query(
      `update kb.jobs set state = 'queued', attempts = greatest(attempts - 1, 0), deferred_count = deferred_count + 1,
         locked_by = null, locked_until = null, lease_token = null, last_error = $2,
         run_after = now() + ($3::bigint * interval '1 millisecond'), updated_at = now()
       where id = $1`, [job.id, String(reason || 'deferred').slice(0, 500), delayMs])
  }

  async function stats(db = pool) {
    const r = await db.query(`select state, count(*)::int n from kb.jobs where state in ('queued','running','failed') group by state`)
    const out = { queued: 0, running: 0, failed: 0 }
    for (const row of r.rows) out[row.state] = row.n
    return out
  }

  return { enqueue, claim, heartbeat, withFence, complete, retry, defer, stats, backoffMs, workerId, leaseMs }
}

module.exports = { createQueue, LeaseLostError }
