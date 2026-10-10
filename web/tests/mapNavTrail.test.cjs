/* eslint-env node */
/**
 * 「返回主脑图 / 返回上级脑图」单测。
 *
 * 1. utils/mapNavTrail.js：用假的 history（按条目存 state，模拟 push / replace / 后退 / 刷新）
 *    跑主脑图、子脑图、多级子脑图、直接打开链接、循环跳转、篡改状态等场景；
 * 2. Toolbar.vue：返回按钮固定在文件工具栏最右侧、复用 ToolbarFileBtnList、按上下文显示；
 * 3. CooperateDialog.vue：进入子脑图时写路径，返回后优先恢复画布位置。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const babel = require('@babel/core')
const compiler = require('vue-template-compiler')

function loadModule(relPath) {
  const filename = path.resolve(__dirname, '..', relPath)
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const moduleRef = { exports: {} }
  new Function('require', 'module', 'exports', code)(
    request => {
      throw new Error(`Unexpected dependency: ${request}`)
    },
    moduleRef,
    moduleRef.exports
  )
  return moduleRef.exports
}

/** 按条目保存 state 的假 history：push 截断前进记录，replace 只改当前条目 */
function createFakeHistory() {
  const entries = [{ state: null }]
  let index = 0
  return {
    get state() {
      return entries[index].state
    },
    get length() {
      return entries.length
    },
    pushState(state) {
      entries.splice(index + 1)
      entries.push({ state })
      index = entries.length - 1
    },
    replaceState(state) {
      entries[index] = { state }
    },
    back() {
      if (index > 0) index--
    },
    forward() {
      if (index < entries.length - 1) index++
    }
  }
}

function createFakeStorage() {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key)
  }
}

const nav = loadModule('src/utils/mapNavTrail.js')
const results = []
function test(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (err) {
    results.push({ name, ok: false })
    console.log(`FAIL  ${name}\n      ${err.message}`)
  }
}

/** 模拟 CooperateDialog.navigateToMapRef：先给当前条目定 navId，push 新条目后写子脑图路径 */
function enterSubMap(history, fromRoom, toRoom) {
  const parentNav = nav.ensureEntryNav(fromRoom, history)
  const trail = nav.buildChildTrail(parentNav, toRoom)
  history.pushState({ key: 'router-key' })
  if (trail.length) nav.writeChildEntryNav(toRoom, trail, history)
  return trail
}

// ---- 1. 导航上下文 ----
test('直接进入主脑图：没有返回按钮', () => {
  const history = createFakeHistory()
  assert.equal(nav.getMapNavContext(history.state, 'room-main'), null)
})

test('主脑图 → 子脑图：显示「返回主脑图」，目标是主脑图', () => {
  const history = createFakeHistory()
  enterSubMap(history, 'room-main', 'room-a')
  const context = nav.getMapNavContext(history.state, 'room-a')
  assert.ok(context)
  assert.equal(context.toMain, true)
  assert.equal(context.parent.room, 'room-main')
})

test('子脑图 A → 子脑图 B：显示「返回上级脑图」，目标是 A', () => {
  const history = createFakeHistory()
  enterSubMap(history, 'room-main', 'room-a')
  enterSubMap(history, 'room-a', 'room-b')
  const context = nav.getMapNavContext(history.state, 'room-b')
  assert.equal(context.toMain, false)
  assert.equal(context.parent.room, 'room-a')
  assert.equal(context.depth, 2)
})

test('直接通过链接打开子脑图（新条目没有状态）：没有返回按钮', () => {
  const history = createFakeHistory()
  history.pushState({ key: 'fresh-tab' })
  assert.equal(nav.getMapNavContext(history.state, 'room-b'), null)
})

test('后退落到的条目就是记录的上级条目；上级条目保留自己的返回路径', () => {
  const history = createFakeHistory()
  enterSubMap(history, 'room-main', 'room-a')
  enterSubMap(history, 'room-a', 'room-b')
  const { parent } = nav.getMapNavContext(history.state, 'room-b')
  history.back()
  assert.equal(nav.isParentEntry(history.state, parent), true)
  const contextA = nav.getMapNavContext(history.state, 'room-a')
  assert.equal(contextA.toMain, true)
  history.back()
  assert.equal(nav.getMapNavContext(history.state, 'room-main'), null)
})

test('浏览器前进：回到子脑图条目后上下文不变', () => {
  const history = createFakeHistory()
  enterSubMap(history, 'room-main', 'room-a')
  enterSubMap(history, 'room-a', 'room-b')
  history.back()
  history.back()
  history.forward()
  history.forward()
  const context = nav.getMapNavContext(history.state, 'room-b')
  assert.equal(context.parent.room, 'room-a')
})

test('刷新（条目 state 原样保留）：上下文不变；vue-router 式 replace 复制 state 也不变', () => {
  const history = createFakeHistory()
  enterSubMap(history, 'room-main', 'room-a')
  const before = nav.getMapNavContext(history.state, 'room-a')
  history.replaceState(Object.assign({}, history.state, { key: 'new-key' }))
  assert.deepEqual(nav.getMapNavContext(history.state, 'room-a'), before)
})

test('replace 把当前条目换成别的脑图：旧路径失效，不显示返回按钮', () => {
  const history = createFakeHistory()
  enterSubMap(history, 'room-main', 'room-a')
  assert.equal(nav.getMapNavContext(history.state, 'room-other'), null)
})

test('循环跳转（A → B → 主脑图）：回到路径里的脑图时截断，不形成循环', () => {
  const history = createFakeHistory()
  enterSubMap(history, 'room-main', 'room-a')
  enterSubMap(history, 'room-a', 'room-b')
  enterSubMap(history, 'room-b', 'room-main')
  assert.equal(nav.getMapNavContext(history.state, 'room-main'), null)
  enterSubMap(history, 'room-main', 'room-a')
  const context = nav.getMapNavContext(history.state, 'room-a')
  assert.equal(context.depth, 1)
  assert.equal(context.toMain, true)
})

test('路径深度有上限', () => {
  const history = createFakeHistory()
  let from = 'room-0'
  for (let i = 1; i <= nav.MAX_MAP_NAV_DEPTH + 5; i++) {
    const to = `room-${i}`
    enterSubMap(history, from, to)
    from = to
  }
  const context = nav.getMapNavContext(history.state, from)
  assert.equal(context.depth, nav.MAX_MAP_NAV_DEPTH)
})

test('篡改的状态一律不认：非法房间号 / 路径含当前脑图 / 版本不对 / 超长路径', () => {
  const field = nav.MAP_NAV_STATE_FIELD
  const make = patch => ({
    [field]: Object.assign(
      {
        version: nav.MAP_NAV_VERSION,
        navId: 'abcdef12-3456',
        room: 'room-b',
        trail: [{ room: 'room-main', navId: 'abcdef12-0000' }]
      },
      patch
    )
  })
  assert.ok(nav.getMapNavContext(make({}), 'room-b'))
  assert.equal(
    nav.getMapNavContext(make({ trail: [{ room: '../admin', navId: 'abcdef12-0000' }] }), 'room-b'),
    null
  )
  assert.equal(
    nav.getMapNavContext(make({ trail: [{ room: 'room-b', navId: 'abcdef12-0000' }] }), 'room-b'),
    null
  )
  assert.equal(nav.getMapNavContext(make({ version: 99 }), 'room-b'), null)
  assert.equal(nav.getMapNavContext(make({ trail: 'room-main' }), 'room-b'), null)
  const longTrail = Array.from({ length: nav.MAX_MAP_NAV_DEPTH + 1 }, (_, i) => ({
    room: `room-${i}`,
    navId: 'abcdef12-0000'
  }))
  assert.equal(nav.getMapNavContext(make({ trail: longTrail }), 'room-b'), null)
})

test('兜底 replace 到上级时，补写的状态沿用上级原来的路径', () => {
  const history = createFakeHistory()
  enterSubMap(history, 'room-main', 'room-a')
  enterSubMap(history, 'room-a', 'room-b')
  const childNav = nav.readEntryNav(history.state, 'room-b')
  const { parent } = nav.getMapNavContext(history.state, 'room-b')
  const parentNav = nav.buildParentEntryNav(childNav.trail, parent)
  assert.equal(parentNav.room, 'room-a')
  assert.equal(parentNav.navId, parent.navId)
  assert.deepEqual(parentNav.trail.map(item => item.room), ['room-main'])
  assert.equal(nav.replaceEntryNav(parentNav, history), true)
  assert.equal(nav.getMapNavContext(history.state, 'room-a').toMain, true)
  assert.equal(nav.buildParentEntryNav(childNav.trail, { room: 'room-x', navId: 'abcdef12-9' }), null)
})

test('视图恢复标记：只对目标脑图生效、只生效一次', () => {
  const storage = createFakeStorage()
  nav.markMapNavViewRestore('room-a', storage)
  assert.equal(nav.consumeMapNavViewRestore('room-b', storage), false)
  assert.equal(nav.consumeMapNavViewRestore('room-a', storage), true)
  assert.equal(nav.consumeMapNavViewRestore('room-a', storage), false)
  nav.markMapNavViewRestore('../bad', storage)
  assert.equal(nav.consumeMapNavViewRestore('../bad', storage), false)
})

// ---- 2. Toolbar.vue ----
const DIR = path.join(__dirname, '..', 'src/pages/Edit/components')
const toolbarSrc = fs.readFileSync(path.join(DIR, 'Toolbar.vue'), 'utf8')
const toolbarSfc = compiler.parseComponent(toolbarSrc)
const toolbarScript = toolbarSfc.script.content

test('Toolbar.vue 模板编译无错误', () => {
  const compiled = compiler.compile(toolbarSfc.template.content)
  assert.deepEqual(compiled.errors, [])
})

test('返回按钮复用 ToolbarFileBtnList，排在「更多」之后（文件工具栏最右侧），无上下文时不渲染', () => {
  const tpl = toolbarSfc.template.content
  const moreIndex = tpl.indexOf('class="toolbarBtn fileMoreBtn"')
  const backIndex = tpl.indexOf('class="mapNavBackList"')
  const fileTreeIndex = tpl.indexOf('class="fileTreeBox"')
  assert.ok(moreIndex > 0 && backIndex > moreIndex && backIndex < fileTreeIndex)
  const block = tpl.slice(tpl.lastIndexOf('<ToolbarFileBtnList', backIndex), backIndex + 200)
  assert.match(block, /v-if="mapNavBackActions\.length"/)
  assert.match(block, /:list="mapNavBackActions"/)
  assert.match(block, /@select="onFileToolbarAction"/)
})

test('按钮文案按场景切换，使用线条图标，不进入「更多」收纳列表', () => {
  assert.match(toolbarScript, /context\.toMain\s*\?\s*this\.\$t\('toolbar\.backToMainMap'\)\s*:\s*this\.\$t\('toolbar\.backToParentMap'\)/)
  assert.match(toolbarScript, /icon:\s*'el-icon-top-left'/)
  assert.match(toolbarScript, /testId:\s*'map-nav-back'/)
  const actionsBody = toolbarScript.slice(
    toolbarScript.indexOf('fileToolbarActions() {'),
    toolbarScript.indexOf('fileHorizontalActions() {')
  )
  assert.doesNotMatch(actionsBody, /mapNavBack/)
  assert.match(toolbarScript, /case 'mapNavBack': return this\.returnToParentMap\(\)/)
})

test('返回前检查未保存修改与上级权限；只在落点不是上级条目时 replace，不 push 新记录', () => {
  const body = toolbarScript.slice(
    toolbarScript.indexOf('async returnToParentMap() {'),
    toolbarScript.indexOf('async replaceWithParentMap(')
  )
  assert.ok(body.indexOf('confirmMapNavLeave()') < body.indexOf('verifyMapNavParentAccess('))
  assert.match(body, /inspectMapRef\(\{ mapId: room \}\)/)
  assert.match(body, /isParentEntry\(window\.history\.state, parent\)/)
  assert.doesNotMatch(body, /\$router\.push/)
  const replaceBody = toolbarScript.slice(toolbarScript.indexOf('async replaceWithParentMap('))
  assert.match(replaceBody.slice(0, 600), /this\.\$router\.replace\(\{ query \}\)/)
})

test('路由变化 / popstate / 进入子脑图事件都会刷新返回上下文，销毁时解绑', () => {
  assert.match(toolbarScript, /'\$route\.fullPath'\(\)\s*\{\s*this\.refreshMapNavContext\(\)/)
  assert.match(toolbarScript, /\$bus\.\$on\('map_nav_context_change', this\.refreshMapNavContext\)/)
  assert.match(toolbarScript, /\$bus\.\$off\('map_nav_context_change', this\.refreshMapNavContext\)/)
  assert.match(toolbarScript, /addEventListener\('popstate', this\.onMapNavPopstate\)/)
  assert.match(toolbarScript, /removeEventListener\('popstate', this\.onMapNavPopstate\)/)
})

test('原有文件工具栏按钮仍在', () => {
  ;['maps', 'refresh', 'check', 'run', 'copyInvite', 'share', 'import', 'export', 'history', 'new', 'saveAs'].forEach(key => {
    assert.match(toolbarScript, new RegExp(`key: '${key}'`), key)
  })
})

// ---- 3. CooperateDialog.vue ----
const coopSrc = fs.readFileSync(path.join(DIR, 'CooperateDialog.vue'), 'utf8')

test('双击同时触发 node_dblclick 与 map_ref_click：navigateToMapRef 并发时只处理第一次', () => {
  const body = coopSrc.slice(coopSrc.indexOf('async navigateToMapRef(ref) {'))
  const fn = body.slice(0, body.indexOf('async openMapRefTarget(ref) {'))
  assert.match(fn, /if \(this\._mapRefNavigating\) return/)
  assert.match(fn, /await this\.openMapRefTarget\(ref\)/)
  assert.match(fn, /finally \{\s*this\._mapRefNavigating = false/)
})

test('进入子脑图：await 之前读上级条目状态，push 成功且房间对得上才写子脑图路径', () => {
  const body = coopSrc.slice(coopSrc.indexOf('async openMapRefTarget(ref) {'))
  const fn = body.slice(0, body.indexOf('\n    tryAutoJoin()'))
  assert.ok(fn.indexOf('ensureEntryNav(current)') < fn.indexOf('await inspectMapRef(ref)'))
  assert.ok(fn.indexOf('roomFromLocation(this.$route) !== current) return') < fn.indexOf('await this.$router.push({ query })'))
  assert.match(fn, /roomFromLocation\(this\.\$route\) !== normalized\.mapId\) return/)
  assert.match(fn, /writeChildEntryNav\(normalized\.mapId, childTrail\)/)
  assert.match(fn, /\$emit\('map_nav_context_change'\)/)
})

test('返回上级后优先恢复离开时的画布位置（先于 shallowExpand / focus 判断）', () => {
  const body = coopSrc.slice(coopSrc.indexOf('async afterMapOpened() {'))
  assert.ok(body.indexOf('consumeMapNavViewRestore(this.roomName)') < body.indexOf('const shallow ='))
})

// ---- 4. 文案 ----
test('四种语言都有返回按钮文案', () => {
  ;['zh_cn', 'zh_tw', 'en_us', 'vi_vn'].forEach(lang => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/lang', `${lang}.js`), 'utf8')
    ;['backToMainMap', 'backToParentMap', 'mapNavUnsavedTitle', 'mapNavUnsavedTip', 'mapNavLeaveAnyway', 'mapNavStay'].forEach(key => {
      assert.match(src, new RegExp(`\\b${key}:`), `${lang}.${key}`)
    })
  })
})

const failed = results.filter(item => !item.ok)
console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`)
if (failed.length) process.exit(1)
