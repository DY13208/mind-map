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
      } else if (url.pathname === '/wwopen/sso/qrConnect') {
        const callback = new URL(process.env.AUTH_APP_ORIGIN + '/api/auth/wecom/callback')
        callback.searchParams.set('code', 'fixture-success')
        callback.searchParams.set('state', url.searchParams.get('state') || '')
        const parentOrigin = new URL(process.env.COGNEE_SSO_REDIRECT_URI).origin
        const styleUrl = new URL('/wecom-qr.css?v=1', parentOrigin).href
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>模拟企业微信接口</title>
          <style>body{margin:0;text-align:center;font:14px sans-serif}p,h4{margin:0}.title{font-size:20px;line-height:24px}.status_txt{display:inline-block}.status_icon{display:inline-block;width:38px;margin-right:12px}button{padding:8px;border:0;background:#1677ff;color:white;border-radius:6px}</style>
          <link rel="stylesheet" href="${styleUrl}">
          <div class="impowerBox"><div class="title">企业微信登录</div><div class="wrp_code"><svg class="qrcode" viewBox="0 0 100 100" aria-label="测试二维码"><rect width="100" height="100" fill="white"/><path fill="black" d="M0 0h30v30H0zM70 0h30v30H70zM0 70h30v30H0zM40 40h20v20H40zM70 50h10v40H70zM40 80h20v20H40zM90 40h10v20H90zM0 40h20v20H0zM40 0h10v20H40z"/><path fill="white" d="M5 5h20v20H5zM75 5h20v20H75zM5 75h20v20H5z"/><path fill="black" d="M10 10h10v10H10zM80 10h10v10H80zM10 80h10v10H10z"/></svg></div>
          <div class="info"><div class="status status_browser" id="wx_default_tip"><p>测试二维码 · 模拟外部接口</p><p>测试应用名称</p></div>
          <div class="status status_succ" id="wx_after_scan" style="display:none"><i class="status_icon">✓</i><div class="status_txt"><h4>扫描成功</h4><p>请在企业微信中确认登录，页面将自动跳转。</p></div></div></div></div>
          <button id="scan">模拟扫描</button><button id="confirm">模拟确认登录</button>
          <script>document.getElementById('scan').onclick=function(){document.getElementById('wx_default_tip').style.display='none';document.getElementById('wx_after_scan').style.display='block'};document.getElementById('confirm').onclick=function(){window.parent.postMessage(${JSON.stringify(callback.href)}, ${JSON.stringify(parentOrigin)})}</script></html>`)
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
