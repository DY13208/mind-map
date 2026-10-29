const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const compiler = require('vue-template-compiler')
const source = fs.readFileSync(path.resolve(__dirname, '../src/pages/Edit/components/Contextmenu.vue'), 'utf8')
const parsed = compiler.parseComponent(source)
const compiled = compiler.compile(parsed.template.content)
assert.deepEqual(compiled.errors, [])
const find = node => {
  if (node.attrsMap && node.attrsMap['data-testid'] === 'publish-node-approval') return node
  for (const child of node.children || []) { const found = find(child); if(found) return found }
}
const menu = find(compiled.ast)
assert.ok(menu, 'editable node menu exposes the approval action')
const siblings = menu.parent.children.filter(node => node.type === 1)
assert.equal(siblings[siblings.indexOf(menu)-1].attrsMap['data-testid'], 'distill-node-skill')
assert.equal(menu.attrsMap['@click'], 'publishNodeApproval')
const context = {MenuIcon:{},mapState:()=>({}),mapMutations:()=>({})}
vm.runInNewContext(parsed.script.content.replace(/^import[\s\S]*?from ['"][^'"]+['"]\r?$/gm, '').replace('export default', 'component='), context)
const clicked = {id:'right-clicked'}, active = {id:'previously-selected'}, events=[],warnings=[]
const instance = {node:clicked,selectedNodes:[active],editable:true,hide(){this.closed=true},$bus:{$emit:(...args)=>events.push(args)},$message:{warning:t=>warnings.push(t)}}
context.component.methods.publishNodeApproval.call(instance)
assert.equal(instance.closed, true)
assert.equal(events.length, 1)
assert.equal(events[0][0], 'publishNodeApproval')
assert.equal(events[0][1], clicked)
instance.editable = false
context.component.methods.publishNodeApproval.call(instance)
assert.equal(events.length, 1)
assert.equal(warnings.length, 1)
instance.editable = true
instance.submenuClickGate = true
context.component.methods.publishNodeApproval.call(instance)
assert.equal(events.length, 1)
console.log('PASS: Vue menu compilation, placement after distill skill, exact clicked node, readonly and submenu guards')
