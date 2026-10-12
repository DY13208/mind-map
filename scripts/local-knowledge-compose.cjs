// Generate read-only Docker mounts from server-owned configuration, never browser input.
const fs = require('node:fs')
const path = require('node:path')
function generate(workspace = path.resolve(__dirname,'..'), env = process.env) {
  const config = {}
  const file = path.join(workspace,'.env')
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file,'utf8').split(/\r?\n/)) {
    const match = line.match(/^(LOCAL_KNOWLEDGE_ROOTS|LOCAL_KNOWLEDGE_ROOT)=(.*)$/)
    if (match) config[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  const raw = env.LOCAL_KNOWLEDGE_ROOTS || config.LOCAL_KNOWLEDGE_ROOTS
  const values = raw ? JSON.parse(raw) : [env.LOCAL_KNOWLEDGE_ROOT || config.LOCAL_KNOWLEDGE_ROOT || './data/local-knowledge']
  if (!Array.isArray(values) || !values.length || values.length>32 || values.some(v=>typeof v!=='string' || !v.trim())) throw new Error('LOCAL_KNOWLEDGE_ROOTS 必须包含1至32个目录路径')
  const seen = new Set(), roots = []
  for (const value of values) {
    const resolved = fs.realpathSync(path.resolve(workspace,value))
    if (!fs.statSync(resolved).isDirectory()) throw new Error('资料路径必须是目录')
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    if (seen.has(key)) continue
    seen.add(key); roots.push({source:resolved.replace(/\\/g,'/'),id:value})
  }
  const targets = roots.map((r,i)=>i===0?'/app/local-knowledge':'/app/local-knowledge-'+(i+1))
  const compose = {services:{app:{environment:{LOCAL_KNOWLEDGE_ROOTS:JSON.stringify(targets),LOCAL_KNOWLEDGE_SOURCE_IDS:JSON.stringify(roots.map(r=>r.id))},volumes:roots.map((r,i)=>({type:'bind',source:r.source,target:targets[i],read_only:true}))}}}
  const output = path.join(workspace,'.secrets','local-knowledge.compose.json')
  fs.mkdirSync(path.dirname(output),{recursive:true}); fs.writeFileSync(output,JSON.stringify(compose,null,2)+'\n')
  return output
}
if (require.main === module) { try { generate(); console.log('已生成多目录只读挂载配置。使用：docker compose -f docker-compose.yml -f .secrets/local-knowledge.compose.json up -d --no-deps app') } catch(error) { console.error('多目录配置失败：'+error.message); process.exit(1) } }
module.exports = {generate}
