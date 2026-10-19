'use strict'
const { AsyncLocalStorage }=require('async_hooks')
const scope=new AsyncLocalStorage(), marker=Symbol('kbMetrics')
function instrumentPool(pool){
  if(typeof pool.connect!=='function'||pool[marker])return pool;pool[marker]=true
  const connect=pool.connect.bind(pool)
  function wrap(c){if(c[marker])return c;c[marker]=true;const query=c.query.bind(c)
    c.query=function(sql,...args){const m=scope.getStore(),start=performance.now();const text=typeof sql==='string'?sql:sql?.text||'';let ended=false
      function end(){if(ended||!m)return;ended=true;const ms=performance.now()-start;m.dbMs+=ms;if(/^\s*(insert|update|delete)/i.test(text))m.dbWriteMs+=ms}
      if(typeof args[args.length-1]==='function'){const cb=args.pop();return query(sql,...args,(...out)=>{end();cb(...out)})}
      try{const p=query(sql,...args);if(p?.finally)return p.finally(end);end();return p}catch(e){end();throw e}
    };return c}
  pool.connect=function(cb){return cb?connect((e,c,release)=>cb(e,c?wrap(c):c,release)):connect().then(wrap)}
  return pool
}
async function measured(job,fn){
  const start=performance.now(),cpu=process.cpuUsage(),m={queueWaitMs:Math.max(0,new Date(job.first_started_at||Date.now()).getTime()-new Date(job.created_at).getTime()),attemptWaitMs:Math.max(0,Date.now()-new Date(job.queue_entered_at||job.created_at).getTime()),dbMs:0,dbWriteMs:0,rssPeakBytes:process.memoryUsage().rss,phase:job.kind}
  const t=setInterval(()=>{m.rssPeakBytes=Math.max(m.rssPeakBytes,process.memoryUsage().rss)},100);t.unref()
  let outcome,error
  try{outcome=await scope.run(m,fn);return {outcome,metrics:m}}catch(e){error=e;return {outcome:'error',error:e,metrics:m}}finally{clearInterval(t);m.totalMs=performance.now()-start;m.rssPeakBytes=Math.max(m.rssPeakBytes,process.memoryUsage().rss);const used=process.cpuUsage(cpu);m.processCpuMs=(used.user+used.system)/1000;m.cpuScope='process-overlapping';m.memoryScope='process-rss-sampled';m[job.kind==='parse'?'parseMs':'structureMs']=m.totalMs;m.computeEstimateMs=Math.max(0,m.totalMs-m.dbMs);if(error)m.failureReason=String(error.message).slice(0,2000)}
}
async function measureUpload(fn){const m={dbMs:0,dbWriteMs:0,rssPeakBytes:process.memoryUsage().rss};const timer=setInterval(()=>{m.rssPeakBytes=Math.max(m.rssPeakBytes,process.memoryUsage().rss)},100);timer.unref();try{return await scope.run(m,fn)}finally{clearInterval(timer)}}
module.exports={instrumentPool,measured,measureUpload,scope}
