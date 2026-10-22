const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const compiler = require('vue-template-compiler')
const { withShell } = require('../tests/loadAttachmentUtils.cjs')('shellMode')
const source = compiler.parseComponent(fs.readFileSync(path.resolve(__dirname, '../src/pages/ProductShell/components/ProductShellLayout.vue'), 'utf8'))
assert.deepEqual(compiler.compile(source.template.content).errors, [])
let saved = null
const media = []
const scope = {
  mobileViewport: {}, UserAvatar: {}, AccessNotificationTrigger: {}, ProductNavigation: {},
  shellTheme: { theme: 'light' }, withShell, applyShellThemeToRoot() {},
  localStorage: { getItem: () => saved, setItem: (key, value) => { saved = value } },
  window: { matchMedia() { const state = { matches: true, addListener(fn) { this.listener = fn }, removeListener(fn) { assert.equal(this.listener, fn); this.listener = null } }; media.push(state); return state }, addEventListener() {}, removeEventListener() {} },
  document: { body: { classList: { remove() {} } }, removeEventListener() {} },
  process: { env: { BASE_URL: '/' } }
}
vm.runInNewContext(source.script.content.replace(/^import .*$/gm, '').replace('export default', 'component ='), scope)
const component = scope.component
const panel = { ...component.data(), ...component.methods, shellMode: 'full', isMobileViewport: false, $bus: { $off() {} } }
assert.equal(panel.sidebarCollapsed, true, 'portrait touch layout starts compact without changing a saved preference')
assert.equal(component.computed.navigationDrawerEnabled.call({ shellMode: 'full', isTouchNavigation: true }), true)
assert.equal(component.computed.navigationDrawerEnabled.call({ shellMode: 'full', isTouchNavigation: false }), false)
const trigger = { isConnected: true }
panel.openSidebar({ currentTarget: trigger })
assert.equal(panel.navigationOpen, true, 'tablet opener opens the actual drawer in full mode')
assert.equal(panel.navigationTrigger, trigger)
assert.equal(saved, null, 'opening a tablet drawer does not change desktop collapse preference')
panel.closeNavigation()
assert.equal(panel.navigationOpen, false)
panel.isTabletNavigation = false
panel.openSidebar()
assert.equal(panel.sidebarCollapsed, false, 'desktop opener retains inline sidebar behavior')
assert.equal(saved, 'false')
let target
panel.$route = { path: '/files', query: { shell: 'focus' } }
panel.$router = { push(location) { target = location } }
panel.openProfile()
assert.equal(target.path, '/profile')
assert.equal(target.query.shell, 'focus', 'profile navigation preserves mode and avoids guard redirects')
component.mounted.call(panel)
assert.equal(typeof panel._tabletNavigationQuery.listener, 'function')
component.beforeDestroy.call(panel)
assert.equal(panel._tabletNavigationQuery.listener, null, 'responsive listener is removed on unmount')
console.log('PASS touch navigation, desktop behavior, preference isolation, profile mode and media listener cleanup')
