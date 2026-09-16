const assert = require('assert')
const fs = require('fs')
const vm = require('vm')
const { EventEmitter } = require('events')
const path = require('path')
const local = new Map()
const source = fs.readFileSync(path.join(__dirname, '../../web/src/utils/personalAppearance.js'), 'utf8')
const context = { JSON, setTimeout, clearTimeout, localStorage: {
  getItem: key => local.get(key), setItem: (key, value) => local.set(key, value)
} }
vm.createContext(context)
vm.runInContext(source.replace('export function', 'function') + '\nthis.bind = bindPersonalAppearance', context)
class MapView extends EventEmitter {
  constructor() {
    super()
    this.opt = { theme: 'classic4', themeConfig: {}, layout: 'logicalStructure' }
    this.cooperate = { isApplyingRemote: false }
    this.renderer = { setLayout() {} }
  }
  getTheme() { return this.opt.theme }
  getCustomThemeConfig() { return this.opt.themeConfig }
  getLayout() { return this.opt.layout }
  initTheme() {}
  render() { this.emit('node_tree_render_end') }
}
;(async () => {
  const stored = new Map()
  const bind = (map, user, get) => context.bind(map, 'room', user,
    get || (() => Promise.resolve({ state: stored.get(user) || {} })),
    (_, state) => { stored.set(user, JSON.parse(JSON.stringify(state))); return Promise.resolve() })
  const a = new MapView(), b = new MapView()
  const stopA = bind(a, 'A'), stopB = bind(b, 'B')
  await Promise.resolve()
  a.opt.theme = 'dark'
  a.emit('view_theme_change', 'dark')
  a.opt.themeConfig = { backgroundColor: '#111' }
  a.emit('view_theme_config_change', a.opt.themeConfig)
  a.opt.layout = 'mindMap'
  a.emit('layout_change', 'mindMap')
  assert.strictEqual(b.getTheme(), 'classic4')
  assert.strictEqual(b.getLayout(), 'logicalStructure')
  stopA(); stopB()
  local.clear() // Reopen in a different browser using server state.
  const reopened = new MapView()
  const stopReopen = bind(reopened, 'A')
  await Promise.resolve()
  assert.strictEqual(reopened.getTheme(), 'dark')
  assert.strictEqual(reopened.getLayout(), 'mindMap')
  assert.strictEqual(reopened.getCustomThemeConfig().backgroundColor, '#111')
  // A late legacy hydrate/render must restore the personal view.
  reopened.opt.theme = 'classic4'
  reopened.render()
  assert.strictEqual(reopened.getTheme(), 'dark')
  stopReopen()
  let resolve
  const c = new MapView()
  const stopC = bind(c, 'C', () => new Promise(r => { resolve = r }))
  c.opt.theme = 'newTheme'; c.emit('view_theme_change', 'newTheme')
  resolve({ state: { theme: 'stale' } })
  await Promise.resolve()
  assert.strictEqual(c.getTheme(), 'newTheme')
  stopC()
  // Execute the actual Cooperate event methods: no shared metadata submission.
  const plugin = fs.readFileSync(path.join(__dirname, '../src/plugins/Cooperate.js'), 'utf8')
  for (const name of ['onThemeChange', 'onLayoutChange']) {
    const match = plugin.match(new RegExp('  ' + name + '\\(([^)]*)\\) \\{([\\s\\S]*?)\\n  \\}'))
    const fn = vm.runInNewContext('(function(' + match[1] + '){' + match[2] + '})', { publishLayoutApplyTrace() {} })
    fn.call({ httpCollabMode: true, isApplyingRemote: false, mindMap: {}, submitMapMeta() { throw Error('shared metadata submitted') } }, 'test')
  }
  console.log('personalAppearance.test.js ok: account isolation, restore, config, late response, no shared submit')
})().catch(err => { console.error(err); process.exit(1) })
