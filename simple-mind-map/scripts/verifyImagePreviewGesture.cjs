const fs = require('fs')
const assert = require('assert').strict
const babel = require('../../web/node_modules/@babel/core')
const filename = require('path').resolve(__dirname, '../src/plugins/NodeImgAdjust.js')
const code = babel.transformSync(fs.readFileSync(filename, 'utf8'), { babelrc: false, configFile: false, plugins: [require.resolve('../../web/node_modules/@babel/plugin-transform-modules-commonjs')] }).code
const ref = { exports: {} }
new Function('require', 'module', 'exports', code)(name => name.includes('utils') ? { resizeImgSizeByOriginRatio: (w,h,x,y) => [Math.min(x,y*w/h), Math.min(y,x*h/w)] } : {}, ref, ref.exports)
const Plugin = ref.exports.default
function fixture(scale = 1) {
  const events = [], commands = []
  const node = { getData: key => key === 'imageSize' ? { width: 100, height: 100 } : key === 'image' ? 'original.png' : { image: 'original.png', imageTitle: 'image' } }
  const map = { on() {}, off() {}, opt: { minImgResizeWidth: 10, minImgResizeHeight: 10, maxImgResizeWidth: 500, maxImgResizeHeight: 500 }, draw: { transform: () => ({ scaleX: scale, scaleY: scale }) }, emit: (...args) => events.push(args), execCommand: (...args) => commands.push(args) }
  const plugin = new Plugin({ mindMap: map })
  Object.assign(plugin, { node, img: { hide() {}, show() {} }, rect: { x: 0, y: 0, x2: 100*scale, y2: 100*scale, width: 100*scale, height: 100*scale }, handleEl: { style: {} }, currentImgWidth: 100*scale, currentImgHeight: 100*scale, isShowHandleEl: true })
  return { plugin, events, commands }
}
const e = (x,y) => ({ clientX:x,clientY:y,preventDefault(){},stopPropagation(){} })
for (const scale of [0.5,1,2]) {
  const {plugin,events,commands} = fixture(scale)
  plugin.onMousedown(e(100*scale,100*scale))
  plugin.onMousemove(e(100*scale+1,100*scale+1))
  plugin.onMouseup(e(100*scale+1,100*scale+1))
  assert.equal(events.filter(x=>x[0]==='node_img_preview').length,1,'click with jitter opens preview at every canvas scale')
  assert.equal(commands.length,0,'preview does not write image dimensions')
}
const drag = fixture(2)
drag.plugin.onMousedown(e(200,200))
drag.plugin.onMousemove(e(240,240))
drag.plugin.onMouseup(e(240,240))
assert.equal(drag.events.filter(x=>x[0]==='node_img_preview').length,0,'drag must not open preview')
assert.equal(drag.commands.length,1)
assert.equal(drag.commands[0][2].width,120,'drag stores logical dimensions at 200% canvas zoom')
drag.plugin.onMouseup(e(240,240))
assert.equal(drag.commands.length,1,'duplicate mouseup cannot apply twice')
console.log('Image click preview, pointer jitter, drag resize and canvas scale checks passed')
let removed = 0
const disposed = fixture()
disposed.plugin.handleEl.remove = () => removed++
disposed.plugin.beforePluginDestroy()
disposed.plugin.onMouseup(e(100,100))
assert.equal(removed,1)
assert.equal(disposed.plugin.handleEl,null)
assert.equal(disposed.events.length,0,'destroyed gesture cannot open a stale image')
