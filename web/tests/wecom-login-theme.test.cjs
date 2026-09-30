const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

const source = fs.readFileSync(path.join(__dirname, '../src/utils/wecomLogin.js'), 'utf8')
const { code } = babel.transformSync(source, {
  babelrc: false, configFile: false,
  plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
})
const calls = []
const instance = { unmount() {} }
const window = { ww: { createWWLoginPanel(options) { calls.push(options); return instance } } }
const mod = { exports: {} }
new Function('module', 'exports', 'window', code)(mod, mod.exports, window)

async function main() {
  const challenge = { corpId: 'corp-fixture', agentId: 'agent-fixture', redirectUri: 'https://example.invalid/callback', state: 'state-fixture' }
  const mount = {}
  const success = []
  const fail = []
  const result = await mod.exports.mountWecomLoginPanel(mount, challenge, {
    onSuccess: value => success.push(value), onFail: value => fail.push(value)
  })
  assert.equal(result, instance)
  assert.equal(calls.length, 1)
  const options = calls[0]
  assert.equal(options.el, mount)
  assert.deepEqual(options.params, {
    login_type: 'CorpApp', appid: challenge.corpId, agentid: challenge.agentId,
    redirect_uri: challenge.redirectUri, state: challenge.state,
    redirect_type: 'callback', panel_size: 'small', color_scheme: 'auto', lang: 'zh'
  })
  options.onLoginSuccess({ code: 'code-fixture' })
  const error = { errCode: 1 }
  options.onLoginFail(error)
  assert.deepEqual(success, ['code-fixture'])
  assert.deepEqual(fail, [error])
  console.log('WeCom login: official auto color scheme, unchanged QR challenge and callbacks passed')
}
main().catch(err => { console.error(err); process.exitCode = 1 })
