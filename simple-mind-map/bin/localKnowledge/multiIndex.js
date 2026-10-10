const path = require('node:path')
const fs = require('node:fs/promises')
const { createIndex } = require('./index')
function configuredRoots(root, roots) {
  const value = roots === undefined && process.env.LOCAL_KNOWLEDGE_ROOTS ? JSON.parse(process.env.LOCAL_KNOWLEDGE_ROOTS) : roots
  const result = value === undefined ? root ? [root] : [] : value
  if (!Array.isArray(result) || result.length > 32 || result.some(r => typeof r !== 'string' || !r.trim())) throw new Error('LOCAL_KNOWLEDGE_ROOTS 必须是最多32个非空目录路径组成的 JSON 数组')
  return [...new Set(result.map(r => path.resolve(r)))]
}
function createMultiIndex({ roots, cacheDir, interval, extract }) {
  let active = 0
  const errors = new Map()
  const waiting = [], shared = new Map(), proxies = new WeakMap(), originals = new WeakMap(), owners = new WeakMap()
  const pump = () => {
    while (active < 2 && waiting.length) {
      const max = Math.max(...waiting.map(j=>j.priority()))
      if (!max && active >= 1) break
      const i = waiting.findIndex(j=>j.priority()===max)
      active++; waiting.splice(i,1)[0].resolve()
    }
  }
  const guardedExtract = async (file, options) => {
    const stat = await fs.stat(file), key = file + ':' + stat.size + ':' + stat.mtimeMs
    if (shared.has(key)) { const entry=shared.get(key); entry.options.push(options); pump(); return entry.promise }
    const entry = {options:[options],promise:null}
    const priority = ()=>Math.max(...entry.options.map(o=>o.getPriority?.()||0))
    entry.promise = (async () => {
      await new Promise(resolve=>{waiting.push({resolve,priority});pump()})
      try { if (options.signal?.aborted) throw Object.assign(new Error('已取消'), {name:'AbortError'}); return await extract(file,options) }
      finally { active--; pump() }
    })()
    shared.set(key,entry)
    try { return await entry.promise } finally { if (shared.get(key) === entry) shared.delete(key) }
  }
  let sourceIds = []
  if (process.env.LOCAL_KNOWLEDGE_SOURCE_IDS) sourceIds = JSON.parse(process.env.LOCAL_KNOWLEDGE_SOURCE_IDS)
  const indices = roots.map((root,i)=>createIndex({root,cacheDir,interval,extract:guardedExtract,sourceId:sourceIds[i] ?? (i===0 ? process.env.LOCAL_KNOWLEDGE_SOURCE_ID || '' : root)}))
  function wrap(record,i) {
    if (!proxies.has(record)) {
      const proxy = new Proxy(record,{get(target,key){return key==='relative' && roots.length>1 ? '资料目录'+(i+1)+'/'+target.relative : target[key]},set(target,key,value){target[key]=value;return true}})
      proxies.set(record,proxy); originals.set(proxy,record); owners.set(proxy,i)
    }
    return proxies.get(record)
  }
  const split = records=>indices.map((index,i)=>records.filter(r=>owners.get(r)===i).map(r=>originals.get(r)))
  const entries = ()=>indices.flatMap((index,i)=>index.entries().map(r=>wrap(r,i)))
  const start = async()=>{await Promise.allSettled(indices.map(async i=>{try{await i.start();errors.delete(i)}catch(error){errors.set(i,'资料目录读取失败')}}))}
  const refresh = async options=>{await start();await Promise.allSettled(indices.map(async i=>{try{await i.refresh(options);errors.delete(i)}catch(error){errors.set(i,'资料目录读取失败')}}))}
  return {
    start,refresh,entries,
    scoped:(key,predicate)=>entries().filter(predicate),
    prioritize(records,priority){split(records).forEach((rows,i)=>indices[i].prioritize(rows,priority));pump()},
    verify:async records=>(await Promise.all(split(records).map((rows,i)=>errors.get(indices[i]) || indices[i].status().error ? Promise.resolve(true) : indices[i].verify(rows)))).every(Boolean),
    ensure:async(records,options)=>{const tasks=split(records).map((rows,i)=>indices[i].ensure(rows,options));pump();await Promise.all(tasks)},
    markDirty(){indices.forEach(i=>i.markDirty())},
    status(){
      const states=indices.map((index,i)=>({...index.status(),error:index.status().lastScan && !index.status().error ? '' : errors.get(index)||index.status().error,label:'资料目录'+(i+1)})), failed=states.filter(s=>s.error)
      return {state:failed.length===states.length?'error':states.some(s=>!s.error && s.state==='updating')?'updating':states.some(s=>!s.error && s.state==='building')?'building':'ready',pendingFiles:states.reduce((n,s)=>n+s.pendingFiles,0),lastScan:Math.min(...states.map(s=>s.lastScan)),error:failed.length===states.length?failed.map(s=>s.error).join('; '):'',roots:states,rootErrors:failed.map(s=>({label:s.label,error:s.error}))}
    },
    close(){indices.forEach(i=>i.close())}
  }
}
module.exports={configuredRoots,createMultiIndex}
