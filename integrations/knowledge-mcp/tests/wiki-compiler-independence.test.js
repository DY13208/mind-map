const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const path = require('node:path')
const { signToken } = require('../src/auth/jwt')

test('MCP starts and registers compiler tools even when Wiki/Docmost adapter modules are removed', async t => {
  const entry = path.resolve(__dirname, '../src/server.js')
  const code = `
    const Module = require('node:module'); const original = Module._load;
    Module._load = function(name, ...args) {
      if (/adapters\\/(docmost|wiki$)/.test(name)) throw new Error('REMOVED_WIKI_MODULE');
      return original.call(this,name,...args);
    };
    const http = require('node:http'); const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function(...args) {
      this.once('listening',()=>console.log('READY:'+this.address().port));
      return listen.apply(this,args);
    };
    require(${JSON.stringify(entry)});
  `
  const secret = 'independent-mcp-token-secret'
  const env = { ...process.env, KNOWLEDGE_MCP_PORT: '0', KNOWLEDGE_MCP_JWT_SECRET: secret,
    KNOWLEDGE_DOCMOST_TOOLS_ENABLED: 'false', PGHOST: '127.0.0.1', PGPORT: '1' }
  for (const key of Object.keys(env)) if (/^DOCMOST_|^DATABASE_URL$|^MIND_MAP_DATABASE_URL$/.test(key)) delete env[key]
  const child = spawn(process.execPath, ['-e', code], { env, stdio: ['ignore','pipe','pipe'], windowsHide: true })
  t.after(() => child.kill())
  let output = ''
  const port = await new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('MCP did not start: '+output)), 5000)
    child.stdout.on('data', data => { output += data; const m = /READY:(\d+)/.exec(output); if (m) { clearTimeout(timer); resolve(Number(m[1])) } })
    child.stderr.on('data', data => { output += data })
    child.on('exit', code => { clearTimeout(timer); reject(new Error('MCP exited '+code+': '+output)) })
  })
  const base = 'http://127.0.0.1:'+port
  assert.equal((await fetch(base+'/health')).status, 200)
  const token = signToken({userId:'alice',secret}).token
  const response = await fetch(base+'/mcp', { method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}) })
  const rpc = await response.json()
  const names = rpc.result.tools.map(t=>t.name)
  assert.deepEqual(names.filter(n=>n.startsWith('wiki_compiler_')), ['wiki_compiler_graph','wiki_compiler_search','wiki_compiler_topic','wiki_compiler_concept'])
  assert.equal(names.some(n=>n.startsWith('docmost_')), false)
})
