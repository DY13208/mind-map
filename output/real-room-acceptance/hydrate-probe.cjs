'use strict'
const fs = require('fs')
const path = require('path')
const { chromium } = require(path.join(
  __dirname,
  '../../simple-mind-map/node_modules/@playwright/test'
))
const envPath = path.join(__dirname, '../../.env')
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const t = line.trim()
  if (!t || t.startsWith('#')) continue
  const i = t.indexOf('=')
  if (i < 1) continue
  const k = t.slice(0, i).trim()
  let v = t.slice(i + 1).trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  if (process.env[k] === undefined) process.env[k] = v
}

const ORIGIN = 'http://127.0.0.1:8989'
const ROOM = 'c2-browser-5000-1788761408598'

;(async () => {
  const login = await fetch(ORIGIN + '/api/auth/dev-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ key: process.env.AUTH_DEV_BYPASS_KEY })
  })
  const cookieHeader = (login.headers.get('set-cookie') || '').split(';')[0]
  const [name, ...rest] = cookieHeader.split('=')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addCookies([
    { name, value: rest.join('='), domain: '127.0.0.1', path: '/', httpOnly: true }
  ])
  const page = await context.newPage()
  await page.goto(ORIGIN + '/?room=' + ROOM, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const root = document.querySelector('#app') && document.querySelector('#app').__vue__
    const stack = root ? [root] : []
    while (stack.length) {
      const vm = stack.pop()
      if (vm && vm.connected && vm.roomName) return true
      ;(vm.$children || []).forEach(c => stack.push(c))
    }
    return false
  }, null, { timeout: 180000 })
  await page.waitForTimeout(1000)
  const before = await page.evaluate(() => {
    const root = document.querySelector('#app').__vue__
    const stack = [root]
    let mm = null
    while (stack.length) {
      const vm = stack.pop()
      if (vm && vm.mindMap && vm.mindMap.renderer) mm = vm.mindMap
      ;(vm.$children || []).forEach(c => stack.push(c))
    }
    const count = { n: 0 }
    const walk = node => {
      if (!node) return
      count.n++
      ;(node.children || []).forEach(walk)
    }
    walk(mm.renderer.renderTree)
    return {
      nodes: count.n,
      rootKids: (mm.renderer.renderTree.children || []).length,
      rootText: mm.renderer.renderTree.data && mm.renderer.renderTree.data.text
    }
  })
  const expanded = await page.evaluate(async () => {
    const root = document.querySelector('#app').__vue__
    const stack = [root]
    let mm = null
    while (stack.length) {
      const vm = stack.pop()
      if (vm && vm.mindMap && vm.mindMap.renderer) mm = vm.mindMap
      ;(vm.$children || []).forEach(c => stack.push(c))
    }
    const node = mm.renderer.findNodeByUid && mm.renderer.findNodeByUid('n0')
    if (!node) return { ok: false, reason: 'n0 not mounted' }
    const t0 = performance.now()
    mm.execCommand('SET_NODE_EXPAND', node, true)
    await new Promise(r => setTimeout(r, 2500))
    const count = { n: 0 }
    const walk = n => {
      if (!n) return
      count.n++
      ;(n.children || []).forEach(walk)
    }
    walk(mm.renderer.renderTree)
    return {
      ok: true,
      ms: performance.now() - t0,
      nodes: count.n,
      n0expand: node.getData('expand'),
      n0children: node.nodeData && node.nodeData.children && node.nodeData.children.length
    }
  })
  const out = { kind: 'real-e2e', room: ROOM, before, expanded }
  fs.writeFileSync(path.join(__dirname, 'hydrate-probe.json'), JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out, null, 2))
  await browser.close()
})().catch(e => {
  console.error(e)
  process.exit(1)
})
