const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const read = file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8').replace(/^import .*\n/gm, '').replace(/export /g, '')
function shell(saved, dark) {
  const values = new Map(saved ? [['product-shell-theme', saved]] : [])
  const media = { matches: dark, addEventListener(name, callback) { this.change = callback } }
  const events = {}, classes = {}, attributes = {}
  const context = { module: { exports: {} }, Vue: { observable: x => x },
    localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    window: { matchMedia: () => media, addEventListener: (name, fn) => { events[name] = fn } },
    document: { documentElement: { setAttribute: (key, value) => { attributes[key] = value }, classList: { toggle: (key, value) => { classes[key] = value } } } } }
  vm.runInNewContext(read('utils/shellTheme.js') + '\nmodule.exports={shellTheme,setShellThemeMode,applyShellThemeToRoot,toggleShellTheme}', context)
  return { ...context.module.exports, media, values, events, classes, attributes }
}
function appearance() {
  const context = { module: { exports: {} }, themeList: [{ value: 'classic', dark: true }, { value: 'lateNightOffice', dark: true }, { value: 'morandi', dark: false }] }
  vm.runInNewContext(read('utils/themeAppearance.js') + '\nmodule.exports={resolveAppearanceTheme}', context)
  return context.module.exports
}
test('system mode follows OS live, explicit modes ignore OS, and preference persists', () => {
  const x = shell(null, true)
  assert.equal(x.shellTheme.mode, 'system')
  assert.equal(x.shellTheme.theme, 'dark')
  x.applyShellThemeToRoot(true)
  x.media.matches = false; x.media.change({ matches: false })
  assert.equal(x.shellTheme.theme, 'light')
  assert.equal(x.classes.shellDark, false)
  x.setShellThemeMode('dark')
  x.media.change({ matches: false })
  assert.equal(x.shellTheme.theme, 'dark')
  assert.equal(x.values.get('product-shell-theme'), 'dark')
  x.setShellThemeMode('system')
  assert.equal(x.shellTheme.theme, 'light')
  assert.equal(x.values.get('product-shell-theme'), 'system')
})
test('existing explicit preference survives reload and cross-tab selection resolves system state', () => {
  const x = shell('light', true)
  assert.equal(x.shellTheme.theme, 'light')
  x.events.storage({ key: 'product-shell-theme', newValue: 'system' })
  assert.equal(x.shellTheme.theme, 'dark')
  x.toggleShellTheme()
  assert.equal(x.shellTheme.mode, 'light')
})
test('dark mode always selects late-night office including legacy dark templates; light restores previous light theme', () => {
  const { resolveAppearanceTheme: resolve } = appearance()
  for (const currentTheme of ['default', 'classic', 'morandi']) {
    assert.equal(resolve({ nextDark: true, currentTheme, heldDarkTheme: 'classic' }).theme, 'lateNightOffice')
  }
  assert.equal(resolve({ nextDark: true, currentTheme: 'lateNightOffice' }).changed, false)
  assert.equal(resolve({ nextDark: false, currentTheme: 'lateNightOffice', heldLightTheme: 'morandi' }).theme, 'morandi')
})
test('room hydration and delayed personal preferences cannot restore light canvas during dark mode', async () => {
  let remote, theme = 'default', config = { backgroundColor: '#fff' }, renders = 0
  const listeners = {}
  const map = { opt: {}, cooperate: {},
    getTheme: () => theme, getCustomThemeConfig: () => config, getLayout: () => 'logicalStructure',
    renderer: { setLayout() {} }, initTheme() { theme = this.opt.theme; config = this.opt.themeConfig },
    render() { renders++ }, emit() {}, on: (name, fn) => { listeners[name] = fn }, off() {} }
  const context = { module: { exports: {} }, localStorage: { getItem: () => null, setItem() {} },
    shellTheme: { theme: 'dark' }, isDarkThemeValue: value => value === 'lateNightOffice' || value === 'dark7', resolveAppearanceTheme: appearance().resolveAppearanceTheme, setTimeout, clearTimeout }
  vm.runInNewContext(read('utils/personalAppearance.js') + '\nmodule.exports={bindPersonalAppearance}', context)
  const stop = context.module.exports.bindPersonalAppearance(map, 'room', 'user', () => new Promise(resolve => { remote = resolve }), async () => {})
  assert.equal(theme, 'lateNightOffice', 'align even without cached appearance')
  remote({ state: { theme: 'default', themeConfig: { backgroundColor: '#ffffff' } } })
  await Promise.resolve()
  assert.equal(theme, 'lateNightOffice')
  assert.equal(config.backgroundColor, undefined)
  assert.ok(renders >= 1)
  theme = 'dark7'; config = {}; listeners.view_theme_change()
  listeners.node_tree_render_end()
  assert.equal(theme, 'dark7', 'explicit deep palette is not overwritten by restore')
  stop()
})
test('store hydration cannot replace the shared mode with stale per-editor isDark', () => {
  const shared = { mode: 'dark', theme: 'dark' }
  const context = { module: { exports: {} }, Vue: { use() {} }, Vuex: { Store: function(config) { return config } },
    shellTheme: shared, setShellThemeMode: mode => { shared.mode = mode; shared.theme = mode === 'dark' ? 'dark' : 'light' }, storeLocalConfig() {} }
  const source = fs.readFileSync(path.join(__dirname, '../src/store.js'), 'utf8').replace(/^import .*\n/gm, '').replace('export default store', 'module.exports = store')
  vm.runInNewContext(source, context)
  const store = context.module.exports
  store.mutations.setLocalConfig(store.state, { isDark: false, showNavigator: true })
  assert.equal(store.state.localConfig.isDark, true)
  assert.equal(store.state.localConfig.appearanceMode, 'dark')
  store.mutations.setLocalConfig(store.state, { appearanceMode: 'light' })
  assert.equal(store.state.localConfig.isDark, false)
  store.mutations.setLocalConfig(store.state, { isDark: true })
  assert.equal(shared.mode, 'dark')
})


test('pre-app appearance resolves before bundles and remains dark between shell and editor', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  for (const [saved, systemDark, expected] of [['dark', false, 'dark'], ['light', true, 'light'], ['system', true, 'dark'], [null, false, 'light']]) {
    let actual
    vm.runInNewContext(script, { localStorage: { getItem: () => saved }, window: { matchMedia: () => ({ matches: systemDark }) }, document: { documentElement: { setAttribute: (_, value) => { actual = value } } } })
    assert.equal(actual, expected)
  }
  assert.ok(html.indexOf('data-app-appearance') < html.indexOf('runtime-config.js'))
  const x = shell('dark', false)
  x.applyShellThemeToRoot(true)
  x.applyShellThemeToRoot(false)
  assert.equal(x.attributes['data-app-appearance'], 'dark', 'route teardown must retain the first-paint background')
  x.setShellThemeMode('light')
  assert.equal(x.attributes['data-app-appearance'], 'light')
})
