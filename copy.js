const fs = require('fs')
const path = require('path')

const src = path.resolve(__dirname, './dist/index.html') 
const dest = path.resolve(__dirname, './index.html') 

if (fs.existsSync(dest)) {
    fs.unlinkSync(dest)
}

if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest)
    fs.unlinkSync(src)
}

const { execSync } = require('child_process')
let commit = process.env.VUE_APP_BUILD_COMMIT || 'unknown'
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: __dirname })
    .toString()
    .trim()
} catch (err) {}
const buildInfo = {
  commit,
  time: new Date().toISOString()
}
fs.writeFileSync(
  path.resolve(__dirname, './dist/build-info.json'),
  JSON.stringify(buildInfo, null, 2)
)

// console.warn('请检查付费插件是否启用！！！')