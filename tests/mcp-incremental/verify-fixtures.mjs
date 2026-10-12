import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { api, appA, seedRoom } from './fixtures.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const runId = String(process.env.MCP_BASELINE_RUN_ID || `fixtures-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '-')
const output = path.join(here, 'results', `${runId}-fixtures.json`)
const db = new Client({
  host: process.env.MCP_BASELINE_PGHOST || '127.0.0.1',
  port: Number(process.env.MCP_BASELINE_PGPORT || 25492),
  database: process.env.MCP_BASELINE_PGDATABASE || 'mcp_incremental_test',
  user: process.env.MCP_BASELINE_PGUSER || 'mcp_test',
  password: process.env.MCP_BASELINE_PGPASSWORD || 'mcp-incremental-test-db-password',
  application_name: `mcp-fixture-verify-${runId}`
})
await db.connect()
const results = []
try {
  for (const kind of ['deep', 'wide', 'long-text']) {
    const roomKey = `mcp-baseline-${runId}-fixture-${kind}`
    const fixture = await seedRoom(appA, roomKey, kind)
    const counts = await db.query(
      `select count(*)::int as stored,
              count(*) filter (where deleted_at is null)::int as live,
              count(*) filter (where is_root)::int as roots,
              count(*) filter (where parent_uid = 'root' and deleted_at is null)::int as root_children,
              max(char_length(data->>'text'))::int as max_text_chars
       from room_nodes where room_key = $1`,
      [roomKey]
    )
    const row = counts.rows[0]
    assert.equal(row.stored, fixture.expectedCount, `${kind} stored rows`)
    assert.equal(row.live, fixture.expectedCount, `${kind} live rows`)
    assert.equal(row.roots, 1, `${kind} root count`)
    if (kind === 'deep') assert.equal(fixture.expectedCount, 80)
    if (kind === 'wide') assert.equal(row.root_children, 600)
    if (kind === 'long-text') assert.equal(row.max_text_chars, 20011)
    results.push({ kind, roomKey, expectedNodes: fixture.expectedCount, ...row, verified: true })
  }
} finally {
  await db.end()
}
fs.writeFileSync(output, `${JSON.stringify({ schema: 1, runId, createdAt: new Date().toISOString(), results }, null, 2)}\n`)
console.log(JSON.stringify({ output, results }))
