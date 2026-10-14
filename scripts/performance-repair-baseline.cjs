// Read-only production snapshot. Never emit environment secrets or raw URLs.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const root = path.resolve(__dirname, '..')
async function main() {
  const response = await fetch('http://127.0.0.1:8990/api/health', { signal: AbortSignal.timeout(8000) })
  if (!response.ok) throw new Error(`health ${response.status}`)
  const health = await response.json()
  const inspector = `const fs=require('fs'),crypto=require('crypto');const names=['mindApi.js','roomNodes.js','mcpServer.mjs','collabV2/operationEventBridge.js'];console.log(JSON.stringify({hashes:Object.fromEntries(names.map(n=>[n,crypto.createHash('sha256').update(fs.readFileSync('/app/simple-mind-map/bin/'+n)).digest('hex')])),flags:Object.fromEntries(['COLLAB_V2','COLLAB_V2_EVENT_BRIDGE','COLLAB_MCP_DIRECT','COLLAB_EVENT_BUS'].map(k=>[k,process.env[k]||null]))}))`
  const deployed = JSON.parse(execFileSync('docker', ['exec', 'mind-map-app-1', 'node', '-e', inspector], { encoding: 'utf8' }))
  const logs = spawnSync('docker', ['logs', '--tail', '3000', 'mind-map-app-1'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  const requests = {}
  for (const line of `${logs.stdout || ''}\n${logs.stderr || ''}`.split('\n')) {
    const match = line.match(/"(GET|POST|PATCH|DELETE|PUT)\s+([^\s]+)\s+HTTP\/[^"]+"\s+(\d{3})/)
    if (!match) continue
    const route = match[2].split('?')[0].replace(/\/api\/files\/[^/]+/g, '/api/files/:room').replace(/\/api\/maps\/[^/]+/g, '/api/maps/:room')
    const key = `${match[1]} ${route} ${match[3]}`
    requests[key] = (requests[key] || 0) + 1
  }
  const sql = "select indexname from pg_indexes where indexname='room_operations_archive_operation_id_idx'; select table_name from information_schema.tables where table_schema='public' and table_name like '%migration%';"
  const schema = spawnSync('docker', ['exec', '-i', 'mind-map-postgres-1', 'sh', '-c', 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'], { input: sql, encoding: 'utf8' })
  if (schema.status) throw new Error('schema read failed')
  const columns = spawnSync('docker', ['exec', '-i', 'mind-map-postgres-1', 'sh', '-c', 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'], {
    input: "select table_name||'.'||column_name||':'||data_type||':'||is_nullable from information_schema.columns where table_schema='public' order by table_name,ordinal_position;",
    encoding: 'utf8'
  })
  if (columns.status) throw new Error('schema column read failed')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const report = { at: new Date().toISOString(), head, healthStatus: response.status, health, deployed,
    checkoutHashes: Object.fromEntries(Object.keys(deployed.hashes).map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(root, 'simple-mind-map/bin', name))).digest('hex')])),
    imageId: execFileSync('docker', ['inspect', 'mind-map-app-1', '--format', '{{.Image}}'], { encoding: 'utf8' }).trim(),
    schema: schema.stdout.trim().split('\n').filter(Boolean), schemaColumnsHash: createHash('sha256').update(columns.stdout).digest('hex'), accessLogCounts: requests,
    accessLogLimitation: Object.keys(requests).length ? 'last 3000 log lines only; not a representative workload' : 'no HTTP access-log rows available in container logs; historical 404 ratio cannot be reconstructed' }
  const output = path.join(root, 'output/performance-repair-20261013')
  fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(path.join(output, 'production-baseline.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ head, bridgeEnabled: health.eventBridge?.enabled, schema: report.schema, requestLogCategories: Object.keys(requests).length, codeMatches: Object.fromEntries(Object.keys(deployed.hashes).map(name => [name, deployed.hashes[name] === report.checkoutHashes[name]])) }, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
