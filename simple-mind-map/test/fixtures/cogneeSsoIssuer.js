// Opt-in HTTPS fixture: real auth/session/code logic in an isolated PostgreSQL schema.
// Only WeCom's external API is simulated. Never load production authentication config.
const fs = require('fs')
const https = require('https')
const { Pool } = require('pg')

if (process.env.COLLAB_E2E !== '1' || process.env.MIND_MAP_SKIP_ROOT_ENV !== '1') {
  throw new Error('SSO fixture requires isolated E2E environment')
}
const schema = process.env.SSO_TEST_SCHEMA || ''
if (!/^test_cognee_protocol_[a-f0-9]{16}$/.test(schema)) {
  throw new Error('SSO fixture requires a randomly named test schema')
}

async function main() {
  const mode = process.argv[2]
  if (mode === 'init' || mode === 'drop') {
    const admin = new Pool({ options: '-c search_path=public' })
    try {
      await admin.query(mode === 'init'
        ? `create schema ${schema}` : `drop schema ${schema} cascade`)
    } finally {
      await admin.end()
    }
    return
  }
  process.env.PGOPTIONS = `-c search_path=${schema}`
  const auth = require('../../bin/auth')
  await auth.initAuth()
  const pool = new Pool()
  const server = https.createServer({
    cert: fs.readFileSync(process.env.SSO_TEST_CERT),
    key: fs.readFileSync(process.env.SSO_TEST_KEY)
  }, async (req, res) => {
    try {
      const url = new URL(req.url, 'https://localhost')
      if (url.pathname === '/_fixture/ready') {
        res.writeHead(200)
        res.end('ready')
      } else if (url.pathname === '/_fixture/expire' && req.method === 'POST') {
        await pool.query("update auth_cognee_codes set expires_at = now() - interval '1 second'")
        res.writeHead(204)
        res.end()
      } else if (url.pathname === '/cgi-bin/gettoken') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ errcode: 0, access_token: 'fixture-token', expires_in: 7200 }))
      } else if (url.pathname === '/cgi-bin/auth/getuserinfo' && url.searchParams.get('code') === 'fixture-success') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ errcode: 0, UserId: 'fresh-member' }))
      } else if (url.pathname === '/cgi-bin/user/get' && url.searchParams.get('userid') === 'fresh-member') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ errcode: 0, userid: 'fresh-member', name: '首次扫码成员', department: [] }))
      } else if (url.pathname.startsWith('/cgi-bin/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ errcode: 60020, errmsg: 'fixture provider failure' }))
      } else if (!await auth.handleAuthApi(req, res)) {
        res.writeHead(404)
        res.end()
      }
    } catch (error) {
      if (!res.headersSent) res.writeHead(500)
      res.end('fixture_failed')
    }
  })
  server.listen(Number(process.env.SSO_TEST_PORT), '127.0.0.1')
}

main().catch(error => { console.error(error.name); process.exitCode = 1 })
