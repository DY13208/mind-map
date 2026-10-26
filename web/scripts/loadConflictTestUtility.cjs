const fs = require('node:fs')
const path = require('node:path')
const babel = require('@babel/core')
module.exports = name => {
  const source = fs.readFileSync(path.join(__dirname, '../src/utils', name + '.js'), 'utf8')
  const code = babel.transformSync(source, {configFile:false,babelrc:false,
    plugins:[require.resolve('@babel/plugin-transform-modules-commonjs')]}).code
  const loaded = {exports:{}}
  new Function('module','exports',code)(loaded,loaded.exports)
  return loaded.exports
}
