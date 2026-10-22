'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..'), out = path.join(root, 'output/mcp-write-guards/unit-suite')
fs.mkdirSync(out, { recursive: true })
const files = [
  'scripts/mcp-write-guards.unit.cjs', 'scripts/mcp-guard-terminal.unit.cjs', 'scripts/mcp-client-guards.unit.cjs',
  'scripts/mcp-authority-partial.unit.cjs',
  'scripts/mcp-background-edit.unit.cjs',
  'simple-mind-map/test/collabTraceSwitch.test.cjs',
  'simple-mind-map/scripts/collab-edit-session.unit.cjs', 'simple-mind-map/scripts/collab-remote-render.unit.cjs',
  'simple-mind-map/scripts/testEditorEditSessionDiscard.cjs',
  'simple-mind-map/scripts/collab-revision-completion.unit.cjs', 'scripts/mcp-own-creation.unit.cjs',
  'simple-mind-map/scripts/mcp-history-replay.unit.cjs',
  'simple-mind-map/test/collabReliability.test.js', 'simple-mind-map/test/collabHistory.test.js',
  'simple-mind-map/test/collabHttpHistoryRefresh.test.js', 'simple-mind-map/test/historyGeneratedIds.test.js',
  'simple-mind-map/test/mcpHistory.test.js', 'simple-mind-map/test/historyVersionTime.test.js',
  'web/scripts/testConflictDraftStore.cjs', 'web/scripts/testCollabConflictEditors.cjs',
  'web/scripts/testConflictDraftPanel.cjs',
  'web/scripts/testConflictDraftInboxEvents.cjs', 'web/scripts/testNodeHyperlink.cjs'
]
const report = { startedAt: new Date().toISOString(), checks: [] }
for (const file of files) {
  const started = Date.now(), result = spawnSync(process.execPath, [file], {
    cwd: root, env: { ...process.env, MIND_MAP_SKIP_ROOT_ENV: '1' }, encoding: 'utf8', windowsHide: true, timeout: 90000
  })
  const log = path.basename(file) + '.log'
  fs.writeFileSync(path.join(out, log), (result.stdout || '') + (result.stderr || '') + (result.error ? result.error.message : ''))
  const check = { file, exitCode: result.status, ok: result.status === 0, durationMs: Date.now() - started, log }
  report.checks.push(check)
  console.log((check.ok ? 'PASS ' : 'FAIL ') + file)
}
report.passed = report.checks.every(check => check.ok)
report.finishedAt = new Date().toISOString()
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(report, null, 2))
if (!report.passed) process.exitCode = 1
