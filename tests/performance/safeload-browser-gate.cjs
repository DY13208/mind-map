"use strict"
const assert = require('node:assert/strict')
const knownExternal = new Set([
  'fonts.googleapis.com/css2',
  'sdk.51.la/js-sdk-pro.min.js',
  'wwcdn.weixin.qq.com/node/open/js/wecom-jssdk-2.3.4.js'
])
function resourceKey(url) {
  try { const value = new URL(url); return value.hostname + value.pathname } catch (_) { return '' }
}
function gateBrowser(observations) {
  assert.ok(observations && Array.isArray(observations.contexts) && observations.contexts.length > 0, 'browser observation did not run')
  const unknownBlocked = observations.blockedNetwork.filter(item => !knownExternal.has(item.host + item.pathname))
  const failed = observations.network.filter(item => item.type === 'requestfailed')
  const badFailed = failed.filter(item => !knownExternal.has(item.hostname + item.pathname) || item.error !== 'net::ERR_FAILED')
  const badHttp = observations.network.filter(item => item.type === 'response' && item.pathname.startsWith('/api/') && item.status >= 400)
  const badConsole = observations.consoleErrors.filter(item => typeof item !== 'object' ||
    item.text !== 'Failed to load resource: net::ERR_FAILED' || !knownExternal.has(resourceKey(item.location && item.location.url)))
  const result = { pageErrorCount: observations.pageErrors.length, unexpectedBlockedCount: unknownBlocked.length,
    businessRequestFailureCount: badFailed.length, businessHttpErrorCount: badHttp.length, unexplainedConsoleErrorCount: badConsole.length,
    explicitlyBlockedExternalResources: observations.blockedNetwork.length,
    classifiedConsoleCount: observations.consoleErrors.length - badConsole.length }
  assert.deepEqual(observations.pageErrors, [], 'unexpected browser page error')
  assert.deepEqual(unknownBlocked, [], 'unclassified blocked external request')
  assert.deepEqual(badFailed, [], 'unexpected request failure')
  assert.deepEqual(badHttp, [], 'business API returned error')
  assert.deepEqual(badConsole, [], 'unexplained browser console error')
  return result
}
module.exports = { gateBrowser }
