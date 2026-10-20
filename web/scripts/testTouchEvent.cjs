const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const assert = require('node:assert/strict')
const source = fs.readFileSync(path.resolve(__dirname, '../../simple-mind-map/src/plugins/TouchEvent.js'), 'utf8')

function fixture(options = {}) {
  const events = [], timers = new Map(), frames = new Map()
  let clock = 1000, nextTimer = 0
  const win = { handlers: new Map(), addEventListener(type, fn) { this.handlers.set(type, fn) }, removeEventListener(type) { this.handlers.delete(type) } }
  const doc = { ...win, handlers: new Map(), defaultView: win, hidden: false }
  const el = { ...win, handlers: new Map(), style: { touchAction: 'pan-y', webkitTouchCallout: 'default' }, contains(target) { return target === this || target.canvas === this }, dispatchEvent(e) { events.push({ target: this, ...e }) } }
  const node = { canvas: el, nodeType: 1, closest(selector) { return selector === '.smm-node' ? this : null }, dispatchEvent(e) { events.push({ target: this, ...e }) } }
  const other = { ...node }
  const outside = { ...node, canvas: null }
  const map = { el, renderer: {}, opt: { minTouchZoomScale: 20, maxTouchZoomScale: -1, ...options }, view: { x: 50, y: 20, scale: 2, transform() { frames.set(frames.size, { x: this.x, y: this.y, scale: this.scale }) } },
    toPos(x, y) { return { x: x - 10, y: y - 20 } }, emit() {},
    drag: { cancelled: 0, cancelDrag() { this.cancelled++ } }, select: { clearSelectionState() {} } }
  const context = { module: { exports: {} }, window: win, document: doc, MouseEvent: class { constructor(type, options) { Object.assign(this, { type }, options) } }, Date: { now: () => clock },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, at: clock + ms }); return id }, clearTimeout(id) { timers.delete(id) } }
  vm.runInNewContext(source.replace('export default TouchEvent', 'module.exports = TouchEvent'), context)
  const plugin = new context.module.exports({ mindMap: map })
  const touch = (x, y, target = node, identifier = 1) => ({ clientX: x, clientY: y, screenX: x, screenY: y, target, identifier })
  const event = (touches, changed = touches, target = touches[0]?.target || changed[0]?.target || el) => ({ target, touches, changedTouches: changed, cancelable: true, prevented: false, preventDefault() { this.prevented = true } })
  const advance = ms => { clock += ms; for (const [id, job] of timers) if (job.at <= clock) { timers.delete(id); job.fn() } }
  const tap = (target = node) => { const point = touch(100,100,target); plugin.onTouchstart(event([point])); plugin.onTouchend(event([], [point])) }
  return { plugin, map, el, node, other, outside, win, doc, events, timers, touch, event, advance, tap }
}
let count = 0
function test(name, fn) { fn(); count++; console.log('PASS', name) }

test('canvas scoped listeners; UI controls stay native', () => {
  const f = fixture()
  assert.equal(f.win.handlers.has('touchstart'), false)
  assert.equal(f.el.handlers.has('touchstart'), true)
  const input = { canvas: f.el, nodeType: 1, closest: () => ({}) }
  const e = f.event([f.touch(10,10,input)])
  f.plugin.onTouchstart(e)
  assert.equal(e.prevented, false)
  assert.equal(f.events.length, 0)
})
test('one-finger background uses middle-button pan, independent of desktop preference', () => {
  const f = fixture({ useLeftKeySelectionRightKeyDrag: true })
  f.plugin.onTouchstart(f.event([f.touch(10,10,f.el)]))
  assert.equal(f.events[0].button, 1)
  assert.equal(f.events[0].buttons, 4)
  f.plugin.onTouchmove(f.event([f.touch(45,35,f.el)]))
  assert.equal(f.events.at(-1).clientX, 45)
  f.plugin.onTouchend(f.event([], [f.touch(45,35,f.el)]))
  assert.equal(f.events.at(-1).type, 'mouseup')
  assert.equal(f.events.at(-1).clientX, 45)
  assert.equal(f.events.some(e => e.type === 'click'), false)
})
test('node dragging uses actual release coordinates and does not synthesize taps', () => {
  const f = fixture(); f.plugin.onTouchstart(f.event([f.touch(10,10)]))
  assert.equal(f.events[0].button, 0)
  f.plugin.onTouchmove(f.event([f.touch(50,40)]))
  f.plugin.onTouchend(f.event([], [f.touch(70,60)]))
  assert.equal(f.events.at(-1).clientX, 70)
  assert.equal(f.events.some(e => e.type === 'dblclick' || e.type === 'click'), false)
})
test('node and canvas mouseup pass the same release event to the drop handler and remove listeners', () => {
  const parser=require('@babel/parser'),{EventEmitter}=require('node:events')
  const drag=fs.readFileSync(path.resolve(__dirname,'../../simple-mind-map/src/plugins/Drag.js'),'utf8')
  const methods=parser.parse(drag,{sourceType:'module'}).program.body.find(n=>n.type==='ClassDeclaration'&&n.id.name==='Drag').body.body
  const code=['bindEvent','unBindEvent','onNodeMouseup'].map(name=>{const method=methods.find(n=>n.key?.name===name);return drag.slice(method.start,method.end)}).join('\n')
  const c={module:{exports:{}},throttle:fn=>fn};vm.runInNewContext(`class Drag {${code}};module.exports=Drag`,c)
  const plugin=new c.module.exports(),bus=new EventEmitter(),received=[]
  Object.assign(plugin,{mindMap:bus,onNodeMousedown(){},onMousemove(){},onMouseup:e=>received.push(e),onKeydown(){},cancelDrag(){},checkOverlapNode(){}})
  plugin.bindEvent()
  const node={uid:'source'},release={clientX:275,clientY:400}
  bus.emit('node_mouseup',node,release);bus.emit('mouseup',release)
  assert.equal(received.length,2);assert.equal(received[0],release);assert.equal(received[1],release)
  plugin.unBindEvent();assert.equal(bus.eventNames().length,0)
})
test('pinch cancels a node drop and anchors at the fingers from non-unit zoom', () => {
  const f = fixture(); const a=f.touch(100,100), b=f.touch(200,100,f.other,2)
  f.plugin.onTouchstart(f.event([a])); f.plugin.onTouchmove(f.event([f.touch(115,100)]))
  f.plugin.onTouchstart(f.event([a,b])); assert.equal(f.map.drag.cancelled,1)
  f.plugin.onTouchmove(f.event([f.touch(110,120),f.touch(310,120,f.other,2)]))
  assert.equal(f.map.view.scale,4)
  assert.equal(f.map.view.x,20) // new center 200 - original map anchor (140 - 50) * 2
  assert.equal(f.map.view.y,-20)
  f.plugin.onTouchend(f.event([], [a,b])); assert.equal(f.events.some(e=>e.type==='click'),false)
})
test('pinch-to-one finger rebases panning and never starts a new node drop', () => {
  const f=fixture(); const a=f.touch(100,100),b=f.touch(200,100,f.other,2)
  f.plugin.onTouchstart(f.event([a,b])); f.plugin.onTouchend(f.event([a],[b]))
  assert.equal(f.events.at(-1).type,'mousedown');assert.equal(f.events.at(-1).button,1)
  assert.equal(f.plugin.moved,true)
  f.plugin.onTouchend(f.event([],[a]));assert.equal(f.events.some(e=>e.type==='click'),false)
})
test('zoom clamps, disabled zoom still permits two-finger panning, zero distance is finite', () => {
  for (const options of [{minTouchZoomScale:50,maxTouchZoomScale:300},{disableTouchZoom:true}]) {
    const f=fixture(options),a=f.touch(100,100),b=f.touch(200,100,f.other,2)
    f.plugin.onTouchstart(f.event([a,b]));f.plugin.onTouchmove(f.event([f.touch(100,100),f.touch(1100,100,f.other,2)]))
    assert.equal(f.map.view.scale,options.disableTouchZoom?2:3)
    f.plugin.onTouchmove(f.event([f.touch(100,100),f.touch(101,100,f.other,2)]))
    assert.equal(f.map.view.scale,options.disableTouchZoom?2:0.5)
  }
  const f=fixture();f.plugin.onTouchstart(f.event([f.touch(1,1),f.touch(1,1,f.other,2)]));f.plugin.onTouchmove(f.event([f.touch(1,1),f.touch(2,1,f.other,2)]));assert.ok(Number.isFinite(f.map.view.x))
})
test('double tap requires two taps on the same node; swipes and other nodes cannot edit', () => {
  const f=fixture();f.tap();f.advance(100);f.tap();assert.equal(f.events.filter(e=>e.type==='dblclick').length,1)
  const g=fixture();g.tap();g.advance(100);g.tap(g.other);assert.equal(g.events.some(e=>e.type==='dblclick'),false)
})
test('long press opens node menu once; cancellation and teardown clear timers and restore styles', () => {
  const f=fixture();f.plugin.onTouchstart(f.event([f.touch(100,100)]));f.advance(501)
  assert.equal(f.events.filter(e=>e.type==='contextmenu').length,1)
  f.plugin.onTouchend(f.event([],[f.touch(100,100)]));assert.equal(f.events.some(e=>e.type==='click'),false)
  f.plugin.onTouchstart(f.event([f.touch(100,100)]));f.plugin.onTouchcancel();f.advance(600)
  assert.equal(f.plugin.mode,null);assert.equal(f.timers.size,0)
  f.plugin.beforePluginDestroy();assert.equal(f.el.style.touchAction,'pan-y');assert.equal(f.win.handlers.size,0);assert.equal(f.doc.handlers.size,0)
})
test('read-only node pans, while outside touches cannot block UI scrolling or release the canvas drag', () => {
  const f=fixture({readonly:true}),a=f.touch(10,10),outside=f.touch(20,20,f.outside,2)
  f.plugin.onTouchstart(f.event([a]));assert.equal(f.events[0].button,1)
  const e=f.event([a,outside],[outside],f.outside);f.plugin.onTouchmove(e);assert.equal(e.prevented,false)
  f.plugin.onTouchend(f.event([a],[outside],f.outside));assert.equal(f.plugin.mouseDown,true)
  f.doc.hidden=true;f.plugin.onVisibilityChange();assert.equal(f.plugin.mouseDown,false)
})

// iPadOS's desktop UA, native page zoom and visual-keyboard resize boundaries.
test('desktop iPad detection without classifying a normal Mac as mobile', () => {
  const utils=fs.readFileSync(path.resolve(__dirname,'../../simple-mind-map/src/utils/index.js'),'utf8')
  const fn=utils.match(/export const isMobile = \(\) => \{[\s\S]*?\n\}/)[0].replace('export const isMobile =','module.exports =')
  for (const [navigator,expected] of [[{userAgent:'Mozilla Macintosh Safari',platform:'MacIntel',maxTouchPoints:5},true],[{userAgent:'Mozilla Macintosh Safari',platform:'MacIntel',maxTouchPoints:0},false],[{userAgent:'Android',platform:'Linux',maxTouchPoints:5},true]]) {
    const c={navigator,module:{exports:{}}};vm.runInNewContext(fn,c);assert.equal(c.module.exports(),expected)
  }
})
test('visual viewport batches keyboard changes, ignores page zoom and cleans listeners', () => {
  const s=fs.readFileSync(path.resolve(__dirname,'../src/utils/mobileViewport.js'),'utf8').replace('export function installMobileViewport','function installMobileViewport')+'\nmodule.exports=installMobileViewport'
  const values=new Map(),handlers=new Map(),vHandlers=new Map();let raf, cancelled=false
  const viewport={height:800,offsetTop:0,scale:1,addEventListener:(k,f)=>vHandlers.set(k,f),removeEventListener:k=>vHandlers.delete(k)}
  const win={innerHeight:800,visualViewport:viewport,requestAnimationFrame:f=>{raf=f;return 1},cancelAnimationFrame:()=>cancelled=true,addEventListener:(k,f)=>handlers.set(k,f),removeEventListener:k=>handlers.delete(k)}
  const doc={documentElement:{style:{getPropertyValue:k=>values.get(k)||'',setProperty:(k,v)=>values.set(k,v),removeProperty:k=>values.delete(k)}}}
  const c={module:{exports:{}}};vm.runInNewContext(s,c);const dispose=c.module.exports(win,doc)
  assert.equal(values.get('--mm-viewport-height'),'800px');viewport.height=400;viewport.offsetTop=80;vHandlers.get('resize')();raf()
  assert.equal(values.get('--mm-viewport-height'),'400px');assert.equal(values.get('--mm-viewport-top'),'80px')
  viewport.scale=2;viewport.height=200;vHandlers.get('resize')();raf();assert.equal(values.get('--mm-viewport-height'),'400px')
  handlers.get('resize')();dispose();assert.equal(cancelled,true);assert.equal(values.size,0);assert.equal(handlers.size,0);assert.equal(vHandlers.size,0)
})
test('a node toolbar opened after selection starts with the live selection and readonly state', () => {
  const compiler=require('vue-template-compiler'),Vue=require('vue')
  const componentSource=compiler.parseComponent(fs.readFileSync(path.resolve(__dirname,'../src/pages/Edit/components/ToolbarNodeBtnList.vue'),'utf8'))
  assert.deepEqual(compiler.compile(componentSource.template.content).errors,[])
  const c={module:{exports:{}},workbuddyFillIcon:'',mapState:()=>({}),mapMutations:()=>({})}
  vm.runInNewContext(componentSource.script.content.replace(/^import .*$/gm,'').replace('export default','module.exports ='),c)
  const selected={isRoot:true,getData:()=>({})}
  const instance=new Vue({...c.module.exports,propsData:{activeNodeList:[selected],historyState:{enabled:true,undoDepth:2,redoDepth:0}},beforeCreate(){this.$bus={$on(){},$off(){}};this.$store={state:{isReadonly:true}}}})
  assert.equal(instance.activeNodes.length,1)
  assert.equal(instance.activeNodes[0],selected)
  assert.equal(instance.readonly,true)
  assert.equal(instance.backEnd,false,'late-mounted toolbar retains existing undo history')
  instance.$destroy()
})
console.log(`${count} mobile interaction regressions passed`)
