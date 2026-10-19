'use strict'
// Isolated lab only. Never accepts mind_map or the business storage volume.
const fs = require('fs')
const path = require('path')
const http = require('http')
const { execFile } = require('child_process')
const crypto=require('crypto')
const { createRequire } = require('module')
const deps = createRequire(path.resolve(__dirname, '../../package.json'))
const { Pool } = deps('pg')
const lab = process.env.KB_LAB_ROOT
if (!lab || !path.resolve(lab).startsWith('D:\\File-KB-Lab-')) throw new Error('KB_LAB_ROOT must be a dedicated lab directory')
const source = process.env.KB_LAB_SOURCE || path.resolve(__dirname, '../../src')
const label = process.env.KB_LAB_LABEL || 'candidate'
function manifest(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?manifest(path.join(dir,e.name)):[{path:path.relative(source,path.join(dir,e.name)).replace(/\\/g,'/'),sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,e.name))).digest('hex')}])}
const sourceManifest=manifest(source)
const sizes = (process.env.KB_LAB_SIZES || '10,30,100').split(',').map(Number)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pool = new Pool({ host: '127.0.0.1', port: 25439, database: 'kb_lab', user: 'postgres', max: 10, statement_timeout: 15000 })
const { loadConfig } = require(path.join(source, 'config'))
const { migrate } = require(path.join(source, 'migrate'))
const { createStorage } = require(path.join(source, 'storage'))
const { createQueue } = require(path.join(source, 'queue'))
const pipelineMod = require(path.join(source, 'pipeline'))
const events = []
const factory = pipelineMod.createPipeline
pipelineMod.createPipeline = args => {
  const p = factory(args)
  return { process: async (job, opts) => {
    const start = Date.now(), rss = process.memoryUsage().rss
    const result = await p.process(job, opts)
    events.push({ fileId: job.file_id, kind: job.kind, attempt: job.attempts, waitMs: start - new Date(job.created_at).getTime(), durationMs: Date.now() - start, rss, result })
    return result
  } }
}
const { createWorker } = require(path.join(source, 'worker'))
const { createApi } = require(path.join(source, 'api'))
const { createHandler } = require(path.join(source, 'server'))
const { createLimiter } = require(path.join(source, 'ratelimit'))
const { createDoclingClient } = require(path.join(source, 'docling/client'))
const percentile = (a, p) => a.length ? a.slice().sort((x,y)=>x-y)[Math.min(a.length-1, Math.ceil(a.length*p)-1)] : null
const stats = () => new Promise(resolve => execFile('docker', ['stats', '--no-stream', '--format', '{{json .}}', 'file-kb-lab-pg-20261019', 'file-kb-lab-docling-20261019', 'mind-map-app-1', 'mind-map-postgres-1', 'mind-map-file-kb-worker-1'], { timeout: 8000 }, (e,out) => resolve(e ? [] : out.trim().split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x)))))
async function main() {
  await migrate(pool, {log:()=>{}})
  for (const n of sizes) {
    const owner = `lab-${label}-${n}-${Date.now()}`
    const storage = createStorage(path.join(lab, 'storage', owner)); await storage.init()
    const config = loadConfig({ FILE_KB_ENABLED:'true', KB_MAX_QUEUED_PER_USER:process.env.KB_LAB_QUEUED||'50', KB_STORAGE_ROOT: storage.root, KB_NATIVE_LIGHT_PARSE:process.env.KB_LAB_NATIVE || 'false', KB_WORKER_CONCURRENCY:process.env.KB_LAB_CONCURRENCY || '2', DOCLING_URL:process.env.KB_LAB_DOCLING_URL || 'http://127.0.0.1:25019', KB_DOCLING_TOTAL_TIMEOUT_MS:'180000', KB_POLL_MS:'100', KB_BACKOFF_BASE_MS:'200', ...(process.env.KB_LAB_LIGHT ? {KB_LIGHT_CONCURRENCY:process.env.KB_LAB_LIGHT, KB_HEAVY_CONCURRENCY:process.env.KB_LAB_HEAVY || '1'} : {}) })
    const queue = createQueue(pool, {leaseMs:config.leaseMs})
    const api = createApi({pool,storage,queue,config,limiter:createLimiter({maxConcurrent:2,perMinute:1000})})
    // Authentication is injected solely in this loopback synthetic harness.
    const handler = createHandler({config,query:(t,p)=>pool.query(t,p),fetchImpl:fetch,api,authenticator:{authenticate:async()=>({id:owner})}})
    const server = http.createServer(handler); await new Promise(r=>server.listen(0,'127.0.0.1',r))
    const origin = `http://127.0.0.1:${server.address().port}`
    const worker = createWorker({pool,config,docling:createDoclingClient({baseUrl:config.doclingUrl,totalTimeoutMs:180000,doOcr:false}),log:()=>{}})
    const files = fs.readdirSync(path.join(lab,'fixtures')).sort().slice(0,n)
    if (files.length !== n) throw new Error('missing fixtures')
    const start = Date.now(), eventStart=events.length, samples=[], uploads=[], healthSamples=[]
    let stopped=false, monitorError=null, monitoring=false, rssPeak=process.memoryUsage().rss, cpuPeak=0, cpuLast=process.cpuUsage(), cpuAt=Date.now()
    const timer=setInterval(async()=>{
      const now=Date.now(), cpu=process.cpuUsage(cpuLast);cpuLast=process.cpuUsage();cpuPeak=Math.max(cpuPeak,(cpu.user+cpu.system)/1000/(now-cpuAt)*100);cpuAt=now;rssPeak=Math.max(rssPeak,process.memoryUsage().rss)
      if(monitoring)return;monitoring=true
      try {const s=await stats();samples.push({at:now,s}); const hs=Date.now();const r=await fetch('http://127.0.0.1:8990/api/health',{signal:AbortSignal.timeout(5000)});healthSamples.push({ms:Date.now()-hs,status:r.status});if(!r.ok)monitorError='business health failed';if(process.memoryUsage().rss>512*1024*1024)monitorError='Node RSS exceeded 512MiB';const doc=s.find(x=>x.Name==='file-kb-lab-docling-20261019');const mem=/([\d.]+)(GiB|MiB)/.exec(doc?.MemUsage||'');if(mem&&Number(mem[1])*(mem[2]==='GiB'?1024:1)>3584)monitorError='Docling RSS exceeded 3.5GiB';}catch(e){monitorError=e.message}finally{monitoring=false}
    },2000)
    await worker.start(config.concurrency)
    let idx=0,backpressure=0,batchId=null
    if(label!=='baseline') {const r=await fetch(origin+'/api/kb/batches',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({name:owner,expectedCount:n})});const b=await r.json();if(!r.ok)throw new Error(JSON.stringify(b));batchId=b.id}
    await Promise.all([0,1].map(async()=>{while(idx<files.length){const name=files[idx++],p=path.join(lab,'fixtures',name);if(fs.statSync(p).size>2*1024*1024)throw new Error('fixture over 2MiB');let result;const ustart=Date.now();for(;;){const form=new FormData();form.append('file',await fs.openAsBlob(p),name);const r=await fetch(origin+'/api/kb/files'+(batchId?'?batch_id='+batchId:''),{method:'POST',headers:{Origin:origin},body:form,signal:AbortSignal.timeout(30000)});result=await r.json();if(r.status===429){backpressure++;if(Date.now()-start>600000)throw new Error('upload timeout');await sleep(result.retryAfterMs||300);continue}if(!r.ok)throw new Error('upload '+r.status+' '+JSON.stringify(result));break}uploads.push({name,ms:Date.now()-ustart,id:result.id});}}))
    const uploadMs=Date.now()-start
    if(batchId){const r=await fetch(origin+`/api/kb/batches/${batchId}/seal`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'});if(!r.ok)throw new Error('seal failed')}
    let final
    try {for(;;){final=(await pool.query('select status,count(*)::int n from kb.files where owner_id=$1 group by status',[owner])).rows;const terminal=final.filter(x=>['done','partial','failed'].includes(x.status)).reduce((s,x)=>s+x.n,0);if(terminal===n)break;if(monitorError)throw new Error('stop condition: '+monitorError);if(Date.now()-start>600000)throw new Error('batch exceeded 10 minutes');await sleep(300)}}finally{clearInterval(timer);await worker.stop(10000);await new Promise(r=>server.close(r))}
    const ev=events.slice(eventStart),parses=ev.filter(e=>e.kind==='parse'),counts=Object.fromEntries(final.map(x=>[x.status,x.n]))
    const invariant=(await pool.query(`select (select count(*) from kb.files where owner_id=$1)::int files,(select count(*) from kb.parse_runs r join kb.files f on f.id=r.file_id where f.owner_id=$1)::int runs,(select count(*) from (select r.run_id,r.sheet,r.row_index,count(*) from kb.records r join kb.files f on f.id=r.file_id where f.owner_id=$1 group by 1,2,3 having count(*)>1) d)::int duplicate_rows,(select count(*) from kb.records r join kb.files f on f.current_run_id=r.run_id where f.owner_id=$1)::int current_records`,[owner])).rows[0]
    const validationPassed=invariant.files===n&&invariant.runs===n&&invariant.duplicate_rows===0&&invariant.current_records===n*40
    const result={label,n,owner,batchId,sourceManifest,validationPassed,limits:{maxFileBytes:2097152,batchTimeoutMs:600000,parseTimeoutMs:180000,workerConcurrency:config.concurrency,ocr:false,heavyConcurrency:config.heavyConcurrency,lightConcurrency:config.lightConcurrency,nativeLightParse:config.nativeLightParse,maxQueuedPerUser:config.maxQueuedPerUser},uploadMs,totalMs:Date.now()-start,parseP50Ms:percentile(parses.map(x=>x.durationMs),.5),parseP95Ms:percentile(parses.map(x=>x.durationMs),.95),waitP50Ms:percentile(parses.map(x=>x.waitMs),.5),waitP95Ms:percentile(parses.map(x=>x.waitMs),.95),rssPeak,cpuPeak,counts,backpressure,retries:ev.filter(x=>x.attempt>1).length,invariant,events:ev,uploads,samples,healthSamples}
    fs.writeFileSync(path.join(lab,`${label}-${n}.json`),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,sourceManifest:undefined,events:undefined,samples:undefined,uploads:undefined,healthSamples:undefined}))
    if(!validationPassed)throw new Error('record/file completeness invariant failed')
    if((counts.failed||0)>n*.2)throw new Error('failure stop threshold >20%')
  }
  await pool.end()
}
main().catch(e=>{console.error(e.stack);process.exit(1)})
