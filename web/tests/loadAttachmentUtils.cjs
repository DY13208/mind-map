const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

module.exports = function loadAttachmentUtils(name = 'nodeAttachmentPreview') {
  const filename = path.resolve(__dirname, '../src/utils', name + '.js')
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const ref = { exports: {} }
  new Function('require', 'module', 'exports', code)(
    name => name === 'simple-mind-map/src/utils/attachmentIconState'
      ? require('../../simple-mind-map/src/utils/attachmentIconState') : require(name),
    ref, ref.exports
  )
  return ref.exports
}
