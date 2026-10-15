// Compare real HEAD production modules with current modules on the same owned
// PG schema. Alternating order controls within-run contention; this is not a
// production/network benchmark. The initial RED baseline remains untouched.
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const { createRequire } = require('node:module')
const { withDirectoryDatabase, seedPreview, seedTeamRooms, response } = require('../../simple-mind-map/test/helpers/directoryPg.cjs')
const root = path.resolve(__dirname, '../..')
function baseline(file) {
  const source = cp.execFileSync('git', ['show', 'HEAD:' + file], { cwd: root, encoding: 'utf8' })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', source)(createRequire(path.join(root, file)), module, module.exports)
  return module.exports
}
function p95(values) { return values.slice().sort((a,b) => a-b)[Math.ceil(values.length * .95) - 1] }
async function paired(old, current) {
  const samples = { baseline: [], current: [] }
  // Warm both production paths equally; exclude these ten pairs from samples.
  for (let i=0; i<10; i++) { await old(); await current() }
  for (let i=0; i<200; i++) {
    for (const [name, run] of i%2 ? [['current', current],['baseline', old]] : [['baseline', old],['current', current]]) {
      const start = performance.now(); await run(); samples[name].push(performance.now()-start)
    }
  }
  const baselineP95 = p95(samples.baseline), currentP95 = p95(samples.current)
  return { ...samples, baselineP95, currentP95, improvement: 1-currentP95/baselineP95 }
}
async function previewRequest(f, key, engine, handler) {
  const req = { method: 'GET', url: `/api/files/${key}/card-preview`,
    authUser: { id: 'owner', corpId: 'corp-a' }, forceAcl: true, headers: {} }
  const res = response()
  req.roomAccess = await f.acl.assertRoomAccess(f.adapter, req, key, 'view')
  await handler(req, res, { engine })
  if (res.code !== 200 || !res.body.preview.sketch.text) throw new Error('Preview fixture request failed')
}
async function teamRequest(f, handler) {
  const req = { method: 'GET', url: '/api/teams/team-a/rooms?limit=20&offset=0&sort=updatedAt&order=desc',
    authUser: { id: 'owner', corpId: 'corp-a' }, forceAcl: true, headers: {} }
  const res = response()
  await handler(req, res, { db: f.adapter, url: new URL(req.url, 'http://fixture.invalid'),
    readBody: f.storage.readBody, sendJson: f.storage.sendJson })
  if (res.code !== 200) throw new Error('Team fixture request failed')
}
async function main() {
  const oldStore = baseline('simple-mind-map/bin/fileSystem/pgStore.js')
  const oldEngine = baseline('simple-mind-map/bin/fileSystem/engine.js')
  const oldHttp = baseline('simple-mind-map/bin/fileSystem/http.js')
  const oldTeam = baseline('simple-mind-map/bin/teamSpace.js')
  const groups=[]
  for (const size of [1000,10000]) {
    await withDirectoryDatabase(async f => {
      const key=await seedPreview(f,{children:size,grandChildren:0})
      await f.client.query('analyze room_nodes')
      const store=oldStore.createPgFileStore(f.adapter)
      const engine=oldEngine.createFileSystem({store})
      groups.push({ operation:'preview-projection-sql',size,
        ...await paired(()=>store.getPreviewNodes(key),()=>f.store.getPreviewNodes(key)) })
      groups.push({ operation:'preview-complete-handler',size,
        ...await paired(()=>previewRequest(f,key,engine,oldHttp.handleFileSystemApi),
          ()=>previewRequest(f,key,f.engine,f.files.handleFileSystemApi)) })
    })
  }
  for (const size of [60,1000,10000]) {
    await withDirectoryDatabase(async f => {
      await seedTeamRooms(f,size)
      await f.client.query('analyze rooms')
      groups.push({ operation:'team-complete-handler',size,
        ...await paired(()=>teamRequest(f,oldTeam.handleApi),()=>teamRequest(f,f.team.handleApi)) })
    })
  }
  const report={generatedAt:new Date().toISOString(),source:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
    boundary:'Real PG SQL plus middleware/handler/sendJson for complete-handler; excludes network/browser. HEAD modules and current code alternate on the same current owned schema/indexes; 10 equal warmups, 200 measured samples per path.',groups}
  const file=path.join(root,'work/performance-tdd/green/directory/paired-benchmark.json')
  fs.writeFileSync(file,JSON.stringify(report,null,2))
  process.stdout.write(JSON.stringify(groups.map(({operation,size,baselineP95,currentP95,improvement})=>({operation,size,baselineP95,currentP95,improvement})),null,2)+'\n')
  if(groups.some(group=>group.size>=1000&&group.improvement<.4)) throw new Error('40% P95 improvement gate failed; see paired-benchmark.json')
  if(groups.some(group=>group.currentP95>group.baselineP95*1.2)) throw new Error('20% P95 regression protection failed')
}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1})
