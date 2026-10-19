// Fault injection against a throwaway file-kb-mcp container wired to a broken JackYun config.
import { Client } from '../../../file-kb-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StreamableHTTPClientTransport } from '../../../file-kb-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'

const scenario = process.argv[2]
const expected = process.argv[3]
const sql = text => execFileSync('docker', ['exec', '-i', 'mind-map-postgres-1', 'sh', '-c', 'psql -U "$POSTGRES_USER" -d mind_map -At -v ON_ERROR_STOP=1'], { input: text, encoding: 'utf8' }).trim()
const raw = crypto.randomBytes(32).toString('hex')
sql(`insert into kb.mcp_tokens (user_id, name, token_prefix, token_hash, scopes, expires_at) values ('e2e-geek-a','e2e-geekcloud-fault','${raw.slice(0, 8)}','${crypto.createHash('sha256').update(raw).digest('hex')}', array['kb:read'], now() + interval '1 hour');`)
let ok = true
const check = (name, cond, detail = '') => { ok = ok && !!cond; console.log(`${cond ? 'PASS' : 'FAIL'}  [${scenario}] ${name}${detail ? '  · ' + detail : ''}`) }
try {
  const client = new Client({ name: 'fault', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:18911/mcp'), { requestInit: { headers: { Authorization: `Bearer ${raw}` } } }))
  const call = async args => {
    const t = Date.now()
    const r = await client.callTool({ name: 'smart_knowledge_query', arguments: args })
    return { ms: Date.now() - t, body: JSON.parse(r.content[0].text) }
  }
  const lf = await client.callTool({ name: 'list_knowledge_files', arguments: {} })
  check('original tool list_knowledge_files works', !lf.isError && JSON.parse(lf.content[0].text).items.length > 0)
  const plain = await call({ query: '面膜使用说明' })
  check('plain file query unaffected', plain.body.sources.fileKb.status === 'ok' && !plain.body.route.geekcloudCalled, `${plain.ms} ms`)
  const sku = await call({ query: 'SKU 8809570319633 库存', mode: 'combined' })
  const g = sku.body.sources.geekcloud
  const code = g.errors && g.errors[0] && g.errors[0].code
  check('SKU query: File KB rows still returned', sku.body.sources.fileKb.status === 'ok' && sku.body.sources.fileKb.records.length === 1)
  check(`SKU query: JackYun part fails as ${expected}`, g.status === 'error' && code === expected, `${code || g.status + '/' + g.reason} in ${sku.ms} ms`)
  if (g.status !== 'error') process.exit(1)
  const again = []
  for (let i = 0; i < 3; i++) again.push(await call({ query: 'SKU 8809570319633 库存', include_file_context: false }))
  const last = again[again.length - 1]
  check('breaker opens after repeated failures (fast fail)', last.body.sources.geekcloud.errors[0].code === 'breaker_open', `${last.ms} ms`)
  await client.close()
} finally {
  sql(`update kb.mcp_tokens set revoked_at = now() where name = 'e2e-geekcloud-fault' and revoked_at is null;`)
}
process.exit(ok ? 0 : 1)
