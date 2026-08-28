const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
const ENV_FILE = path.join(ROOT, '.env')

function loadRootEnv() {
  if (!fs.existsSync(ENV_FILE)) return
  fs.readFileSync(ENV_FILE, 'utf8')
    .split(/\r?\n/)
    .forEach(line => {
      const text = line.trim()
      if (!text || text.startsWith('#')) return
      const index = text.indexOf('=')
      if (index <= 0) return
      const key = text.slice(0, index).trim()
      let value = text.slice(index + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (process.env[key] === undefined) process.env[key] = value
    })
}

loadRootEnv()

module.exports = { ROOT, loadRootEnv }
