'use strict'
const crypto = require('crypto')
const { Pool } = require('pg')

async function rpc(url, token, body, session) {
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream'
  }
  if (session) headers['mcp-session-id'] = session
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await res.text()
  const sessionId = res.headers.get('mcp-session-id')
  let data
  try { data = JSON.parse(text) } catch (_) { data = { raw: text.slice(0, 500) } }
  return { status: res.status, sessionId, data }
}

async function main() {
  const pool = new Pool()
  const file = (await pool.query("select id, owner_id from kb.files where name = '一张表.xlsx' and deleted_at is null")).rows[0]
  const raw = crypto.randomBytes(32).toString('hex')
  const hash = crypto.createHash('sha256').update(raw).digest('hex')
  const inserted = await pool.query(
    `insert into kb.mcp_tokens (user_id, name, token_prefix, token_hash, scopes)
     values ($1, 'header-check', $2, $3, '{kb:read}') returning id`,
    [file.owner_id, raw.slice(0, 8), hash])
  const tokenId = inserted.rows[0].id
  const url = 'http://file-kb-mcp:18801/mcp'
  try {
    const init = await rpc(url, raw, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'header-check', version: '1' } }
    })
    if (init.status !== 200) throw new Error(`initialize ${init.status}`)
    await rpc(url, raw, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId)
    const call = await rpc(url, raw, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'query_knowledge_records',
        arguments: {
          fileId: file.id,
          pageSize: 3,
          filters: [
            { field: '部门', op: 'eq', value: '个护部' },
            { field: '日常工作', op: 'eq', value: '行业大盘' }
          ]
        }
      }
    }, init.sessionId)
    const dateCall = await rpc(url, raw, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: {
        name: 'query_knowledge_records',
        arguments: {
          fileId: file.id,
          pageSize: 2,
          filters: [{ field: '交付日期', op: 'contains', value: '6月9日' }]
        }
      }
    }, init.sessionId)
    const old = await rpc(url, raw, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: {
        name: 'query_knowledge_records',
        arguments: {
          fileId: file.id,
          pageSize: 1,
          filters: [{ field: '周一-周日为每周重复工作、1-31为每月重复工作、Q1-Q4为每季度重复工作', op: 'contains', value: '部门' }]
        }
      }
    }, init.sessionId)
    const pick = body => {
      const text = body && body.result && body.result.content && body.result.content[0] && body.result.content[0].text
      const parsed = text ? JSON.parse(text) : body
      const items = (parsed.items || parsed.records || []).map(r => ({
        sheet: r.sheet, row: r.row, parseVersion: r.parseVersion,
        dept: r.data && r.data['部门'], person: r.data && r.data['人员'], work: r.data && r.data['日常工作'],
        date: r.data && r.data['交付日期']
      }))
      return { total: parsed.total, items, error: parsed.error || (body.error && body.error.message) }
    }
    console.log(JSON.stringify({
      work: pick(call.data),
      date: pick(dateCall.data),
      oldField: pick(old.data)
    }, null, 2))
  } finally {
    await pool.query('delete from kb.mcp_tokens where id = $1', [tokenId])
    await pool.end()
  }
}

main().catch(err => { console.error(err.message); process.exit(1) })
