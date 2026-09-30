const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const compiler = require('vue-template-compiler')
const babel = require('@babel/core')

const source = fs.readFileSync(path.join(__dirname, '../src/components/LoginGridBackground.vue'), 'utf8')
const sfc = compiler.parseComponent(source)
assert.deepEqual(compiler.compile(sfc.template.content).errors, [])
assert.match(sfc.template.content, /aria-hidden="true"/)
assert.doesNotMatch(sfc.template.content, /<slot|<button|<input|<iframe/)
const script = sfc.script.content.replace(
  /await import\(\/\* webpackChunkName: "login-grid" \*\/ '.\/canvasui\/grid'\)/,
  'await loadGrid()'
)
const { code } = babel.transformSync(script, {
  babelrc: false,
  configFile: false,
  plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
})

function fixture({ reduced = false, coarse = false, hidden = false, missingObserver = false, result = 'ok', pending = false } = {}) {
  const events = new Set()
  const eventTarget = prefix => ({
    addEventListener(name) { events.add(`${prefix}:${name}`) },
    removeEventListener(name) { events.delete(`${prefix}:${name}`) }
  })
  const motion = { matches: reduced, ...eventTarget('motion') }
  const pointer = { matches: coarse, ...eventTarget('pointer') }
  const window = {
    matchMedia: query => query.includes('reduced-motion') ? motion : pointer,
    ResizeObserver: missingObserver ? null : function () {},
    IntersectionObserver: function () {}
  }
  const document = { hidden, ...eventTarget('document') }
  const calls = []
  let destroys = 0
  let imports = 0
  let resolve
  const api = { createGrid(...args) { calls.push(args); return result === 'null' ? null : { destroy() { destroys++ } } } }
  const loadGrid = () => {
    imports++
    if (result === 'reject') return Promise.reject(new Error('chunk unavailable'))
    if (pending) return new Promise(r => { resolve = r })
    return Promise.resolve(api)
  }
  const mod = { exports: {} }
  new Function('module', 'exports', 'window', 'document', 'loadGrid', 'setTimeout', 'clearTimeout', code)(
    mod, mod.exports, window, document, loadGrid, () => 1, () => {}
  )
  const component = mod.exports.default
  const parent = {}
  const ctx = {
    ...component.data(),
    $el: { parentElement: parent },
    $refs: { source: {}, content: {}, output: eventTarget('canvas') }
  }
  for (const [name, method] of Object.entries(component.methods)) ctx[name] = method.bind(ctx)
  component.mounted.call(ctx)
  return { ctx, calls, events, document, motion, pointer, parent, component, api,
    get imports() { return imports }, get destroys() { return destroys },
    resolve() { resolve(api) }, destroy() { component.beforeDestroy.call(ctx) }
  }
}

async function main() {
  const engineSource = fs.readFileSync(path.join(__dirname, '../src/components/canvasui/grid.js'), 'utf8')
  const engineCode = babel.transformSync(engineSource, {
    babelrc: false, configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  }).code
  const engineModule = { exports: {} }
  new Function('require', 'module', 'exports', engineCode)(() => ({}), engineModule, engineModule.exports)
  assert.equal(engineModule.exports.createGrid({ output: { getContext: () => null } }), null)
  for (const failure of ['vertex', 'fragment', 'link', 'tile']) {
    let shaderNumber = 0
    const shaders = new Set()
    const programs = new Set()
    const gl = {
      isContextLost: () => false,
      createShader() { const s = ++shaderNumber; shaders.add(s); return s },
      shaderSource() {}, compileShader() {},
      getShaderParameter(s) { return s !== ({ vertex: 1, fragment: 2, tile: 4 }[failure]) },
      deleteShader(s) { shaders.delete(s) },
      createProgram() { const p = {}; programs.add(p); return p },
      attachShader() {}, linkProgram() {},
      getProgramParameter(p, key) { return key === this.LINK_STATUS ? failure !== 'link' : 0 },
      deleteProgram(p) { programs.delete(p) },
      LINK_STATUS: 'link', ACTIVE_UNIFORMS: 'uniforms'
    }
    assert.throws(() => engineModule.exports.createGrid({
      output: { getContext: () => gl }, source: { getContext: () => null }
    }, { captureHtml: false }), /Grid (shader|program) unavailable/)
    assert.equal(shaders.size, 0, `${failure} releases partial shaders`)
    assert.equal(programs.size, 0, `${failure} releases partial programs`)
  }
  for (const options of [{ reduced: true }, { coarse: true }, { hidden: true }, { missingObserver: true }]) {
    const f = fixture(options)
    await f.ctx.syncGrid()
    assert.equal(f.ctx.gridState, 'static')
    assert.equal(f.imports, 0)
    f.destroy()
    assert.equal(f.events.size, 0)
  }
  const active = fixture()
  await active.ctx.syncGrid()
  assert.equal(active.ctx.gridState, 'active')
  assert.equal(active.calls[0][0].listenTarget, active.parent)
  assert.equal(active.calls[0][1].captureHtml, false)
  assert.equal(active.calls[0][1].idleRipples, 0)
  await active.ctx.syncGrid()
  assert.equal(active.imports, 1)
  active.motion.matches = true
  await active.ctx.syncGrid()
  assert.equal(active.ctx.gridState, 'static')
  assert.equal(active.destroys, 1)
  active.motion.matches = false
  await active.ctx.syncGrid()
  assert.equal(active.ctx.gridState, 'active')
  active.ctx.onContextLost()
  await active.ctx.syncGrid()
  assert.equal(active.ctx.gridState, 'static')
  assert.equal(active.destroys, 2)
  active.destroy()
  assert.equal(active.events.size, 0)
  assert.equal(active.destroys, 2)

  for (const result of ['null', 'reject']) {
    const f = fixture({ result })
    await f.ctx.syncGrid()
    await f.ctx.syncGrid()
    assert.equal(f.ctx.gridState, 'static')
    assert.equal(f.imports, 1)
    f.destroy()
    assert.equal(f.events.size, 0)
  }
  const stale = fixture({ pending: true })
  const loading = stale.ctx.syncGrid()
  stale.destroy()
  stale.resolve()
  await loading
  assert.equal(stale.calls.length, 0)
  assert.equal(stale.ctx.gridState, 'static')

  const hidden = fixture({ pending: true })
  const started = hidden.ctx.syncGrid()
  hidden.document.hidden = true
  await hidden.ctx.syncGrid()
  hidden.resolve()
  await started
  assert.equal(hidden.calls.length, 0)
  hidden.destroy()
  assert.equal(hidden.events.size, 0)
  console.log('Login Grid: desktop init, SSR-free lazy loading, reduced motion, touch, capability fallback, context loss, failed chunk and cleanup passed')
}
main().catch(err => { console.error(err); process.exitCode = 1 })
