const { commandError } = require('./conflictErrors')
const { stripSearchHtml } = require('./roomNodes')

function stableValue(value) {
  try {
    return JSON.stringify(value === undefined ? null : value)
  } catch (err) {
    return String(value)
  }
}

function expectedValueForKey(data, key) {
  if (key.startsWith('__fv.')) {
    const group = key.slice('__fv.'.length)
    const versions = data && data.__fv
    return versions && typeof versions === 'object' ? versions[group] : undefined
  }
  return data && data[key]
}

function assertExpectedNodeData(data, payload = {}) {
  const expected = payload.expected || payload.expectedValue
  if (!expected || typeof expected !== 'object') return

  const conflict = Object.keys(expected)
    .filter(key => key !== 'revision' && key !== 'uid')
    .find(key => {
      const currentValue = expectedValueForKey(data || {}, key)
      if (key === 'text') {
        return stripSearchHtml(currentValue) !== stripSearchHtml(expected[key])
      }
      return stableValue(currentValue) !== stableValue(expected[key])
    })

  if (conflict) {
    throw commandError('目标已被其他协作者修改', 'REPLACE_CONFLICT', 409)
  }
}

function withExpectedCondition(body, payload) {
  const next = { ...(payload || {}) }
  if (next.expected !== undefined || next.expectedValue !== undefined) return next
  if (body && body.expected !== undefined) next.expected = body.expected
  else if (body && body.expectedValue !== undefined) {
    next.expectedValue = body.expectedValue
  }
  return next
}

module.exports = { assertExpectedNodeData, withExpectedCondition }
