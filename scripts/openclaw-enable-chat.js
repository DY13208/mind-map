/**
 * 在 WSL 内执行：确保 openclaw.json 开启 chatCompletions。
 * 用法: node openclaw-enable-chat.js [/path/to/openclaw.json]
 * 输出一行：ALREADY_ENABLED | ENABLED | NO_CONFIG | ERROR:...
 * 退出码：0 已开启/刚开启，2 无配置，1 其它错误
 */
const fs = require('fs')

const cfg =
  process.argv[2] ||
  process.env.OPENCLAW_CONFIG_PATH ||
  (process.env.HOME
    ? require('path').join(process.env.HOME, '.openclaw', 'openclaw.json')
    : '')

function fail(code, msg) {
  process.stdout.write(msg + '\n')
  process.exit(code)
}

if (!cfg || !fs.existsSync(cfg)) {
  fail(2, 'NO_CONFIG')
}

let json
try {
  json = JSON.parse(fs.readFileSync(cfg, 'utf8'))
} catch (err) {
  fail(1, 'ERROR:parse')
}

const prev =
  ((((json.gateway || {}).http || {}).endpoints || {}).chatCompletions || {})
    .enabled === true ||
  ((((json.gateway || {}).http || {}).endpoints || {}).chatCompletions || {})
    .enabled === 'true'

if (prev) {
  fail(0, 'ALREADY_ENABLED')
}

json.gateway = json.gateway || {}
json.gateway.http = json.gateway.http || {}
json.gateway.http.endpoints = json.gateway.http.endpoints || {}
json.gateway.http.endpoints.chatCompletions =
  json.gateway.http.endpoints.chatCompletions || {}
json.gateway.http.endpoints.chatCompletions.enabled = true

try {
  fs.writeFileSync(cfg, JSON.stringify(json, null, 2) + '\n', 'utf8')
} catch (err) {
  fail(1, 'ERROR:write')
}

fail(0, 'ENABLED')
