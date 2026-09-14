/**
 * Browser E2E: after MCP add_node, open the room UI and assert the node is visible.
 *
 * Env:
 *   COLLAB_TEST_BASE_URL   default http://127.0.0.1:8989
 *   AUTH_DEV_BYPASS_KEY    required for login wall
 *   MCP_ACCEPT_ROOM        room key (created by runner if empty)
 *   MCP_ACCEPT_TEXT        node text to assert
 *   MCP_TOKEN              used only when creating room / writing via MCP
 */
const assert = require('assert')
const { chromium } = require('playwright')
const { randomUUID } = require('crypto')

try {
  require('../bin/loadEnv')
} catch (_) {}

function loadSecretFromDocker(name) {
  if (String(process.env[name] || '').trim()) return
  try {
    const { execFileSync } = require('child_process')
    const value = execFileSync(
      'docker',
      ['exec', 'mind-map-app-1', 'printenv', name],
      { encoding: 'utf8' }
    ).trim()
    if (value) process.env[name] = value
  } catch (_) {
    // host .env / existing env only
  }
}

loadSecretFromDocker('MCP_TOKEN')
loadSecretFromDocker('AUTH_DEV_BYPASS_KEY')

const baseUrl = (
  process.env.COLLAB_TEST_BASE_URL || 'http://127.0.0.1:8989'
).replace(/\/$/, '')
const marker =
  process.env.MCP_ACCEPT_TEXT || `浏览器MCP写入-${Date.now()}`
const headed = process.env.HEADED === '1'
const skipWrite = process.env.MCP_ACCEPT_SKIP_WRITE === '1'

function authHeaders(extra = {}) {
  const token = String(process.env.MCP_TOKEN || '').trim()
  assert.ok(token, 'MCP_TOKEN required')
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...extra
  }
}

async function ensureRoomAndWrite() {
  let roomKey = String(process.env.MCP_ACCEPT_ROOM || '').trim()
  if (!roomKey) {
    roomKey = `mcp-browser-${randomUUID().slice(0, 8)}`
    const created = await fetch(`${baseUrl}/api/files`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        room_key: roomKey,
        title: '浏览器验收',
        tree: { data: { uid: 'root', text: '浏览器验收根' }, children: [] }
      })
    })
    assert.ok(created.ok, `create room ${created.status}`)
  }

  if (skipWrite) {
    console.log('skip write, assert existing room', roomKey)
    return roomKey
  }

  async function mcp(sessionId, body) {
    const headers = {
      ...authHeaders(),
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2024-11-05'
    }
    if (sessionId) headers['mcp-session-id'] = sessionId
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })
    const raw = await response.text()
    const sid = response.headers.get('mcp-session-id') || sessionId
    let data = null
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        try {
          data = JSON.parse(line.slice(5).trim())
        } catch (_) {}
      }
    }
    if (!data && raw) {
      try {
        data = JSON.parse(raw)
      } catch (_) {}
    }
    return { response, data, sessionId: sid, raw }
  }

  const init = await mcp(null, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-browser-e2e', version: '1.0.0' }
    }
  })
  assert.ok(init.response.ok, `MCP init ${init.response.status}`)
  await mcp(init.sessionId, {
    jsonrpc: '2.0',
    method: 'notifications/initialized'
  })
  const call = await mcp(init.sessionId, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'add_node',
      arguments: {
        room_key: roomKey,
        parent: 'root',
        text: marker,
        note: 'browser e2e via MCP'
      }
    }
  })
  assert.ok(call.response.ok, `MCP add_node HTTP ${call.response.status}`)
  assert.ok(call.data && call.data.result && !call.data.result.isError, call.raw)
  console.log('MCP wrote', marker, 'into', roomKey)
  return roomKey
}

async function loginIfNeeded(page) {
  const key = String(process.env.AUTH_DEV_BYPASS_KEY || '').trim()
  assert.ok(key, 'AUTH_DEV_BYPASS_KEY required for browser login')

  const loginHeading = page.getByText('企业微信扫码登录')
  if (!(await loginHeading.isVisible().catch(() => false))) {
    console.log('already authenticated')
    return
  }

  await page.getByRole('button', { name: '开发者密钥登录' }).click()
  await page
    .getByPlaceholder('输入 .env 中的 AUTH_DEV_BYPASS_KEY')
    .fill(key)
  await page.getByRole('button', { name: '进入' }).click()
  await page.waitForURL(url => !url.pathname.includes('login'), {
    timeout: 30000
  }).catch(() => {})
  await loginHeading.waitFor({ state: 'hidden', timeout: 30000 })
  console.log('dev login ok')
}

async function main() {
  const roomKey = await ensureRoomAndWrite()
  const shareUrl = `${baseUrl}/?room=${encodeURIComponent(roomKey)}`
  console.log('open', shareUrl)

  const browser = await chromium.launch({ headless: !headed })
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()
  try {
    await page.goto(shareUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await loginIfNeeded(page)
    await page.goto(shareUrl, { waitUntil: 'networkidle', timeout: 60000 })

    // Mind-map text may live in SVG / foreignObject / canvas-adjacent DOM.
    await page.waitForTimeout(2500)
    const found = await page.waitForFunction(
      text => {
        const body = document.body && document.body.innerText
        if (body && body.includes(text)) return true
        const nodes = Array.from(document.querySelectorAll('*'))
        return nodes.some(el => (el.textContent || '').includes(text))
      },
      marker,
      { timeout: 45000 }
    )
    assert.ok(found, `UI missing node text: ${marker}`)

    const shot = `mcp-browser-accept-${Date.now()}.png`
    const shotPath = require('path').join(__dirname, 'reports', shot)
    require('fs').mkdirSync(require('path').dirname(shotPath), { recursive: true })
    await page.screenshot({ path: shotPath, fullPage: true })
    console.log('VISIBLE ok:', marker)
    console.log('SCREENSHOT', shotPath)
    console.log('PASSED browser MCP acceptance')
  } finally {
    await browser.close()
  }
}

main().catch(err => {
  console.error('FAILED:', err && err.stack ? err.stack : err)
  process.exit(1)
})
