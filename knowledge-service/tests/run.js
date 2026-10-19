const { spawn } = require('child_process')
const path = require('path')

const tests = ['unit.test.js', 'acl.test.js', 'boundary.test.js', 'pg.test.js']
let index = 0

function next(code) {
  if (code) process.exit(code)
  const file = tests[index]
  index += 1
  if (!file) process.exit(0)
  const child = spawn(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' })
  child.on('exit', next)
}

next(0)
