const { envFlag } = require('./flag')

function isTraceOn() {
  try {
    if (typeof process === 'undefined' || !process.env) return false
    if (process.env.COLLAB_V2_TRACE != null && process.env.COLLAB_V2_TRACE !== '') {
      return envFlag('COLLAB_V2_TRACE', false)
    }
    return process.env.NODE_ENV !== 'production'
  } catch (err) {
    return false
  }
}

function collabTrace(stage, detail = {}) {
  if (!isTraceOn()) return
  const row = {
    t: new Date().toISOString(),
    stage,
    ...(detail && typeof detail === 'object' ? detail : { detail })
  }
  console.info('[v2-trace]', stage, row)
}

module.exports = { isTraceOn, collabTrace }
