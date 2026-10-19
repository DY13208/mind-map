'use strict'
const { visibleSql, requireRole }=require('./access')
const { httpError }=require('./errors')
const { sourceOf }=require('./source')
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COLS={sku:['r.sku','text'],price:['r.price','number'],stock:['r.stock','integer'],date:['r.record_date','date'],record_date:['r.record_date','date']}
function validDate(v) {return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) && !isNaN(new Date(v+'T00:00:00Z')) && new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v}
function compileFilter(f,p) {
  if(!f || typeof f.field!=='string' || !f.field || f.field.length>200 || /[\x00-\x1f]/.test(f.field))throw httpError(400,'bad_filter')
  if(f.column!=null && !Object.prototype.hasOwnProperty.call(COLS,f.column))throw httpError(400,'bad_filter_column')
  const key=f.column||f.field
  let [expr,type]=(Object.prototype.hasOwnProperty.call(COLS,key)?COLS[key]:null)||[null,null]
  if(!expr){p.push(f.field);expr=`(r.data->>$${p.length})`;type=f.type|| (f.op==='range' ? ([f.min,f.max].some(x=>/^\d{4}-\d{2}-\d{2}$/.test(String(x)))?'date':'number'):'text');
    if(['number','numeric','integer','int'].includes(type))expr=`kb.try_numeric(${expr})`
    else if(type==='date')expr=`kb.try_date(${expr})`
    else if(type!=='text' && type!=='string')throw httpError(400,'bad_filter_type')
  }
  const numeric=['number','numeric','integer','int'].includes(type)
  function bind(v){
    if(v==null || typeof v==='object' || (numeric && (!/^[-+]?\d+(\.\d+)?$/.test(String(v)) || !Number.isFinite(Number(v)))) || (type==='integer' && !/^[-+]?\d+$/.test(String(v))) || (type==='date'&&!validDate(v)))throw httpError(400,'bad_filter_value')
    p.push(v);return `$${p.length}${numeric?'::numeric':type==='date'?'::date':'::text'}`
  }
  if(f.op==='eq')return `${expr} = ${bind(f.value)}`
  if(f.op==='contains'){p.push('%'+String(f.value??'').replace(/[%_\\]/g,m=>'\\'+m)+'%');return `${expr}::text ilike $${p.length}`}
  if(f.op==='range'){const a=[];if(f.min!=null&&f.min!=='')a.push(`${expr} >= ${bind(f.min)}`);if(f.max!=null&&f.max!=='')a.push(`${expr} <= ${bind(f.max)}`);if(!a.length)throw httpError(400,'bad_filter');return a.join(' and ')}
  throw httpError(400,'bad_filter_op')
}
async function queryRecords(db,user,{fileId,filters=[],page=1,pageSize=50,limit,cursor,sheet,tableIndex}={}) {
  if(typeof filters==='string'){try{filters=JSON.parse(filters)}catch(_){throw httpError(400,'bad_filters')}}
  if(!Array.isArray(filters)||filters.length>20)throw httpError(400,'bad_filters')
  const p=[],where=['f.deleted_at is null','r.run_id=f.current_run_id',visibleSql(user,'file','f',p)]
  if(fileId){if(!UUID.test(fileId))throw httpError(400,'bad_file_id');await requireRole(db,user,'file',fileId,'viewer');p.push(fileId);where.push(`r.file_id=$${p.length}`)}
  if(sheet!=null){p.push(String(sheet));where.push(`r.sheet=$${p.length}`)}
  if(tableIndex!=null){if(!Number.isInteger(Number(tableIndex))||Number(tableIndex)<0)throw httpError(400,'bad_table_index');p.push(Number(tableIndex));where.push(`r.table_index=$${p.length}`)}
  for(const f of filters)where.push(compileFilter(f,p))
  const from='from kb.records r join kb.files f on f.id=r.file_id'
  const total=(await db.query(`select count(*)::int n ${from} where ${where.join(' and ')}`,p)).rows[0].n
  const cap=Math.min(200,Math.max(1,Number(limit||pageSize)||50))
  if(cursor){let a;try{a=JSON.parse(Buffer.from(cursor,'base64url').toString())}catch(_){throw httpError(400,'bad_cursor')}
    if(!Array.isArray(a)||a.length!==4||!UUID.test(String(a[0]))||!Number.isInteger(a[2])||!/^\d+$/.test(String(a[3])))throw httpError(400,'bad_cursor')
    p.push(a[0],String(a[1]),a[2],String(a[3]));where.push(`(r.file_id,r.sheet,r.row_index,r.id)>($${p.length-3}::uuid,$${p.length-2},$${p.length-1}::int,$${p.length}::bigint)`)
  }
  const off=cursor?0:(Math.max(1,Number(page)||1)-1)*cap
  const rows=(await db.query(`select r.*,f.name file_name,f.parse_version,to_char(r.record_date,'YYYY-MM-DD') date_text,
    (select max(fd.col_index)+1 from kb.fields fd where fd.run_id=r.run_id and fd.sheet=r.sheet and fd.table_index=r.table_index) column_count
    ${from} where ${where.join(' and ')} order by r.file_id,r.sheet,r.row_index,r.id limit $${p.length+1} offset $${p.length+2}`,[...p,cap+1,off])).rows
  const shown=rows.slice(0,cap),last=shown[shown.length-1],next=rows.length>cap?Buffer.from(JSON.stringify([last.file_id,last.sheet,last.row_index,String(last.id)])).toString('base64url'):null
  const items=shown.map(r=>({id:String(r.id),fileId:r.file_id,fileName:r.file_name,parseVersion:r.parse_version,blockId:null,sheet:r.sheet,tableIndex:r.table_index,row:r.row_index+1,rowIndex:r.row_index,coordinateVersion:2,rowBase:1,data:r.data,sku:r.sku,price:r.price==null?null:Number(r.price),stock:r.stock,recordDate:r.date_text,date:r.date_text,source:sourceOf(r)}))
  return {items,records:items,total,page:Number(page)||1,pageSize:cap,nextCursor:next,next_cursor:next,coordinateVersion:2,rowBase:1}
}
module.exports={queryRecords,compileFilter}
