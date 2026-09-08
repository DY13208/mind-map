const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildPreviewSketch,
  sketchFromPreviewRows
} = require('../bin/fileSystem/previewSketch')

test('buildPreviewSketch from nested root tree', () => {
  const sketch = buildPreviewSketch({
    root: {
      data: { text: '<p>蔡徐坤</p>' },
      children: [
        {
          data: { text: '二级节点A' },
          children: [{ data: { text: '分支主题1' } }]
        },
        { data: { text: '二级节点B' }, children: [] }
      ]
    }
  })
  assert.equal(sketch.text, '蔡徐坤')
  assert.equal(sketch.children.length, 2)
  assert.equal(sketch.children[0].text, '二级节点A')
  assert.equal(sketch.children[0].children[0].text, '分支主题1')
})

test('buildPreviewSketch from flat uid map', () => {
  const sketch = buildPreviewSketch({
    root: {
      isRoot: true,
      data: { text: 'Root' },
      children: ['a', 'b']
    },
    a: { data: { text: 'A' }, children: ['a1'] },
    b: { data: { text: 'B' }, children: [] },
    a1: { data: { text: 'A1' }, children: [] }
  })
  assert.equal(sketch.text, 'Root')
  assert.equal(sketch.children.map(item => item.text).join(','), 'A,B')
  assert.equal(sketch.children[0].children[0].text, 'A1')
})

test('sketchFromPreviewRows builds truncated tree', () => {
  const sketch = sketchFromPreviewRows([
    { uid: 'root', is_root: true, parent_uid: null, position: '', data: { text: '主题' } },
    { uid: 'c1', is_root: false, parent_uid: 'root', position: 'a', data: { text: '子1' } },
    { uid: 'c2', is_root: false, parent_uid: 'root', position: 'b', data: { text: '子2' } },
    { uid: 'g1', is_root: false, parent_uid: 'c1', position: 'a', data: { text: '孙1' } }
  ])
  assert.equal(sketch.text, '主题')
  assert.equal(sketch.children.length, 2)
  assert.equal(sketch.children[0].children[0].text, '孙1')
})
