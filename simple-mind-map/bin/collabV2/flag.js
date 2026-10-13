function envFlag(name, defaultOn) {
  const raw = process.env[name]
  if (raw == null || raw === '') return !!defaultOn
  return !/^(0|false|off|no)$/i.test(String(raw).trim())
}

function isCollabV2Enabled() {
  return envFlag('COLLAB_V2', true)
}

function isCollabV2EventBridgeEnabled() {
  return isCollabV2Enabled() && envFlag('COLLAB_V2_EVENT_BRIDGE', false)
}

function isCollabV2Trace() {
  if (process.env.COLLAB_V2_TRACE != null && process.env.COLLAB_V2_TRACE !== '') {
    return envFlag('COLLAB_V2_TRACE', false)
  }
  return process.env.NODE_ENV !== 'production'
}

module.exports = {
  isCollabV2Enabled,
  isCollabV2EventBridgeEnabled,
  isCollabV2Trace,
  envFlag
}
