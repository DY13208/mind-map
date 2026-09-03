const { envPath, readRuntime } = require('./helpers')
const fs = require('fs')

module.exports = async () => {
  const stack = global.__COLLAB_E2E_STACK__
  if (stack && stack.close) {
    await stack.close()
  } else {
    try {
      const runtime = readRuntime()
      if (runtime.pid) process.kill(runtime.pid)
    } catch (err) {}
  }
  try {
    fs.unlinkSync(envPath())
  } catch (err) {}
}
