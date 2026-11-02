const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
function setup({ reduced = false, supported = true, failAnimation = false, stallCapture = false, stallAnimation = false, stallNative = false } = {}) {
  let updates = 0, capture, animation, skipped = 0, animationCancelled = 0
  const classes = new Set()
  const listeners = {}
  const doc = { addEventListener: (name, fn) => { listeners[name] = fn }, removeEventListener: name => { delete listeners[name] }, documentElement: { classList: { add: x => classes.add(x), remove: x => classes.delete(x) }, animate: (frames, options) => {
    animation = { frames, options }
    if (failAnimation) throw Error('interrupted')
    return { finished: stallAnimation ? new Promise(() => {}) : Promise.resolve(), cancel() { animationCancelled++ } }
  } } }
  if (supported) doc.startViewTransition = fn => {
    capture = fn
    if (stallCapture) {
      let reject
      const ready = new Promise((_, fail) => { reject = fail })
      return { ready, finished: Promise.resolve(), skipTransition: () => { skipped++; reject(Error('capture timeout')) } }
    }
    const ready = Promise.resolve().then(fn)
    return { ready, finished: stallNative ? new Promise(() => {}) : ready, skipTransition: () => { skipped++ } }
  }
  const win = { innerWidth: 1000, innerHeight: 800, matchMedia: () => ({ matches: reduced }), requestAnimationFrame: () => { throw Error('rendering is paused during capture') } }
  const context = { module: { exports: {} }, setTimeout, clearTimeout }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/utils/themeReveal.js'),'utf8').replace('export async function','async function')+'\nmodule.exports = revealThemeChange',context)
  const run = (extra = {}) => context.module.exports({ document: doc, window: win, element: { contains: () => false, getBoundingClientRect: () => ({ left: 880, top: 20, width: 40, height: 40 }) }, update: () => { updates++ }, nextTick: async () => {}, ...extra })
  return { run, classes, listeners, updates: () => updates, animation: () => animation, skipped: () => skipped, animationCancelled: () => animationCancelled }
}
test('reveals from the button center and covers the farthest corner', async () => {
  const x = setup(); await x.run()
  assert.equal(x.updates(),1)
  assert.equal(x.animation().frames.clipPath[0], 'circle(0px at 900px 40px)')
  assert.equal(x.animation().frames.clipPath[1], `circle(${Math.ceil(Math.hypot(900,760))}px at 900px 40px)`)
  assert.equal(x.animation().options.duration,420)
  assert.equal(x.classes.size,0)
})
test('reduced-motion and older browsers change theme without animation', async () => {
  for (const options of [{ reduced: true }, { supported: false }]) {
    const x=setup(options); await x.run(); assert.equal(x.updates(),1); assert.equal(x.animation(),undefined); assert.equal(x.classes.size,0)
  }
})
test('interrupted animation preserves selection and removes the snapshot class', async () => {
  const x=setup({ failAnimation:true }); await x.run(); assert.equal(x.updates(),1);assert.equal(x.skipped(),1);assert.equal(x.classes.size,0)
})
test('rapid click cancels stale update instead of restoring an older mode', async () => {
  const x=setup(); const first=x.run(); await x.run(); await first
  assert.equal(x.updates(),1); assert.ok(x.skipped()>=1);assert.equal(x.classes.size,0)
})

test('slow snapshot capture exits within watchdog and still applies the selected theme', async () => {
  const x = setup({ stallCapture: true })
  await x.run()
  assert.equal(x.updates(), 1)
  assert.ok(x.skipped() >= 1)
  assert.equal(x.animation(), undefined)
  assert.equal(x.classes.size, 0)
})

test('a rapid click releases a stranded custom animation and cancels its resources', async () => {
  const x = setup({ stallAnimation: true })
  const first = x.run()
  for (let i = 0; i < 12 && !x.animation(); i++) await Promise.resolve()
  assert.ok(x.animation())
  await x.run()
  await first
  assert.equal(x.animationCancelled(), 1)
  assert.equal(x.classes.size, 0)
  assert.equal(x.updates(), 2)
})
test('native transition finished remaining pending cannot freeze subsequent clicks', async () => {
  const x = setup({ stallNative: true })
  await x.run()
  assert.equal(x.classes.size, 0)
  for (let i = 0; i < 20; i++) await x.run()
  assert.equal(x.updates(), 21)
  assert.equal(x.classes.size, 0)
})

test('snapshot-retargeted click is forwarded once, cancels old animation and removes listeners', async () => {
  const x = setup({ stallAnimation: true })
  let repeated, prevented = 0, stopped = 0
  const first = x.run({ onRepeat: () => { repeated = x.run() } })
  for (let i = 0; i < 12 && !x.animation(); i++) await Promise.resolve()
  assert.ok(x.listeners.click)
  x.listeners.click({ target: {}, clientX: 900, clientY: 40, preventDefault() { prevented++ }, stopImmediatePropagation() { stopped++ } })
  await repeated
  await first
  assert.equal(x.updates(), 2)
  assert.equal(prevented, 1)
  assert.equal(stopped, 1)
  assert.equal(x.animationCancelled(), 1)
  assert.equal(Object.keys(x.listeners).length, 0)
  assert.equal(x.classes.size, 0)
})


test('editor origin is independent of the clicked control and reaches all four corners', async () => {
  const x = setup()
  await x.run({ originElement: { getBoundingClientRect: () => ({ left: 8, top: 8, width: 984, height: 784 }) } })
  assert.equal(x.animation().frames.clipPath[0], 'circle(0px at 500px 400px)')
  assert.equal(x.animation().frames.clipPath[1], `circle(${Math.ceil(Math.hypot(500,400))}px at 500px 400px)`)
})

test('editor snapshot waits for queued graph render and disposes its listener', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/utils/editorThemeReveal.js'), 'utf8')
  const listeners = new Set(), canvas = {}, control = {}
  let options, changed = false, ticked = false
  const context = { setTimeout, clearTimeout, document: { querySelector: () => canvas }, revealThemeChange: async args => {
    options = args
    args.update()
    await args.nextTick()
    assert.equal(changed, true)
    assert.equal(ticked, true)
  } }
  vm.runInNewContext(source.replace(/^import .*$/gm, '').replace(/export function /g, 'function ') + '\nthis.run = revealEditorThemeChange', context)
  await context.run({ element: control, mindMap: { on: (_, fn) => listeners.add(fn), off: (_, fn) => listeners.delete(fn) },
    update() { assert.equal(listeners.size, 1); changed = true; setTimeout(() => listeners.forEach(fn => fn()), 0) },
    nextTick: async () => { ticked = true } })
  assert.equal(options.originElement, canvas)
  assert.equal(options.element, control)
  assert.equal(listeners.size, 0)
})

test('scrolling during a reveal releases the snapshot so theme cards remain aligned', async () => {
  const x = setup({ stallAnimation: true })
  const first = x.run()
  for (let i = 0; i < 12 && !x.animation(); i++) await Promise.resolve()
  x.listeners.scroll()
  await first
  assert.equal(x.classes.size, 0)
  assert.equal(x.animationCancelled(), 1)
  assert.equal(Object.keys(x.listeners).length, 0)
})
