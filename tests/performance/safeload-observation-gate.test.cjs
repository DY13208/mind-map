"use strict"
const test = require('node:test')
const assert = require('node:assert/strict')
const { gateBrowser } = require('./safeload-browser-gate.cjs')
const valid = () => ({ contexts: [{}], pageErrors: [], blockedNetwork: [
  { host: 'fonts.googleapis.com', pathname: '/css2' }
], network: [{ type: 'requestfailed', hostname: 'fonts.googleapis.com', pathname: '/css2', error: 'net::ERR_FAILED' }],
consoleErrors: [{ text: 'Failed to load resource: net::ERR_FAILED', location: { url: 'https://fonts.googleapis.com/css2' } }] })
test('only the precise wall-blocked external resource is classified', () => {
  assert.equal(gateBrowser(valid()).classifiedConsoleCount, 1)
})
test('the same ERR_FAILED text for a business URL remains a failure', () => {
  const x = valid(); x.consoleErrors[0].location.url = 'http://127.0.0.1:1234/api/files'
  assert.throws(() => gateBrowser(x), /unexplained browser console error/)
})
test('real API errors and page exceptions are never hidden by external-resource classification', () => {
  const api = valid(); api.network.push({ type: 'response', pathname: '/api/files', status: 500 })
  assert.throws(() => gateBrowser(api), /business API returned error/)
  const page = valid(); page.pageErrors.push('real renderer error')
  assert.throws(() => gateBrowser(page), /unexpected browser page error/)
})
