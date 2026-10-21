'use strict'

function parseSwitch(value) {
  if (value === true) return true
  if (value === false) return false
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}

function querySwitch(windowLike) {
  try {
    const search = String((windowLike.location && windowLike.location.search) || '')
    const match = /(?:\?|&)collabTrace=([^&#]*)(?:&|$)/i.exec(search)
    if (!match) return null
    return parseSwitch(decodeURIComponent(match[1].replace(/\+/g, ' ')))
  } catch (_) {
    return null
  }
}

function isCollabTraceOn(windowLike) {
  const target = windowLike || (typeof window !== 'undefined' ? window : null)
  if (!target) return false

  // Precedence is intentional: a setting at a higher level wins over every
  // lower-level setting, including an explicit false value.
  const globalSetting = parseSwitch(target.__COLLAB_V2_TRACE__)
  if (globalSetting !== null) return globalSetting

  let storageSetting = null
  try {
    const storage = target.localStorage
    storageSetting = storage ? parseSwitch(storage.getItem('COLLAB_V2_TRACE')) : null
  } catch (_) {
    // Storage can be unavailable in restricted browser contexts. Continue to
    // runtime configuration and the URL switch.
  }
  if (storageSetting !== null) return storageSetting

  let runtimeSetting = null
  try {
    const runtime = target.__MIND_MAP_RUNTIME__ || {}
    runtimeSetting = parseSwitch(runtime.collabV2Trace)
  } catch (_) {
    // A malformed runtime config must not prevent URL-based diagnostics.
  }
  if (runtimeSetting !== null) return runtimeSetting

  return querySwitch(target) === true
}

module.exports = { isCollabTraceOn }
