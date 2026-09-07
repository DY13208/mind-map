const assert = require('assert')
const fs = require('fs')
const path = require('path')

const source = fs
  .readFileSync(path.join(__dirname, 'avatar.js'), 'utf8')
  .replace(/export /g, '')
const { isAvatarImage, avatarInitial, resolveAvatar } = new Function(
  `${source}; return { isAvatarImage, avatarInitial, resolveAvatar }`
)()

assert.strictEqual(isAvatarImage('https://wework.qpic.cn/bizmail/abc/0'), true)
assert.strictEqual(isAvatarImage('http://wx.qlogo.cn/mmhead/abc/0'), true)
assert.strictEqual(isAvatarImage('//wework.qpic.cn/bizmail/abc/0'), true)
assert.strictEqual(isAvatarImage('data:image/png;base64,abc'), true)
assert.strictEqual(isAvatarImage('张'), false)
assert.strictEqual(isAvatarImage(''), false)

assert.strictEqual(avatarInitial('张三'), '张')
assert.strictEqual(avatarInitial('', '依'), '依')

assert.deepStrictEqual(
  resolveAvatar({
    name: '张三',
    avatar: 'https://wework.qpic.cn/bizmail/abc/0'
  }),
  { src: 'https://wework.qpic.cn/bizmail/abc/0', initial: '张' }
)
assert.deepStrictEqual(resolveAvatar({ name: '张三', avatar: '张' }), {
  src: '',
  initial: '张'
})
assert.deepStrictEqual(resolveAvatar({ name: '张三' }, '用'), {
  src: '',
  initial: '张'
})

console.log('avatar unit tests passed')
