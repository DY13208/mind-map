'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { randomBytes } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { Pool } = require('pg')
const core = require('../bin/checkRuns')
const store = require('../bin/checkRuns/store')

test('真实 PostgreSQL 事务：并发修订防覆盖、失败回滚、重复核对幂等', async () => {
  const inspected = spawnSync('docker', ['inspect', process.env.CPD_TEST_PG_CONTAINER || 'mind-map-postgres-1'], { encoding: 'utf8' })
  assert.equal(inspected.status, 0, '测试数据库容器无法读取')
  const container = JSON.parse(inspected.stdout)[0]
  const env = Object.fromEntries(container.Config.Env.map(value => { const at = value.indexOf('='); return [value.slice(0, at), value.slice(at + 1)] }))
  const port = container.NetworkSettings.Ports['5432/tcp'][0].HostPort
  const schema = `cpd_runtime_${randomBytes(8).toString('hex')}`
  const connection = { host: '127.0.0.1', port, user: env.POSTGRES_USER || 'postgres', password: env.POSTGRES_PASSWORD, database: env.POSTGRES_DB || 'mind_map' }
  const admin = new Pool(connection)
  let db
  try {
    await admin.query(`create schema ${schema}`)
    db = new Pool({ ...connection, options: `-c search_path=${schema}`, max: 4 })
    const snapshot = { mapVersion: '1', sources: [], nodes: {
      root: { uid: 'root', text: '盘点流程', children: ['c', 'p'] },
      c: { uid: 'c', text: 'C：库存准确率达到98%；未达标时复核。', children: [] },
      p: { uid: 'p', text: 'P：库存准确率达到98%。', children: ['d'] },
      d: { uid: 'd', text: 'D：盘点库存', note: '频率：每周\n判据：准确率98%', data: { frequency: '每周', criterion: '准确率98%', owner: '仓库主管', outputs: '盘点表' }, children: [] }
    } }
    const deps = { db, loadSnapshot: async () => snapshot, searchSources: async () => ({ status: 'no_results', candidates: [] }) }
    const actor = { id: 'test-editor' }
    const run = await core.createCheck({ roomKey: 'test-room', nodeUid: 'd', actor, requestId: 'create' }, deps)
    const finding = run.report.findings.find(value => value.ruleId === 'CK-27')
    assert.equal(finding.reviewable, true)
    const body = { roomKey: run.roomKey, runId: run.id, actor, findingKey: finding.findingKey, decision: 'confirm', reason: '完整核对所有C/P条目', evidenceIds: finding.requiredEvidenceIds, expectedRevision: 1 }
    const concurrent = await Promise.allSettled([
      core.reviewCheck({ ...body, requestId: 'a' }, deps),
      core.reviewCheck({ ...body, requestId: 'b' }, deps)
    ])
    assert.equal(concurrent.filter(value => value.status === 'fulfilled').length, 1)
    assert.equal(concurrent.find(value => value.status === 'rejected').reason.statusCode, 409)
    const updated = await store.getRun(db, run.roomKey, run.id)
    assert.equal(updated.report.revision, 2)
    assert.equal(updated.report.reviewDecisions.length, 1)
    const winningId = updated.report.reviewDecisions[0].requestId
    const duplicate = await core.reviewCheck({ ...body, requestId: winningId }, deps)
    assert.equal(duplicate.report.revision, 2)
    await assert.rejects(store.editRun(db, run.roomKey, run.id, async (_, client) => {
      await client.query('update check_runs set report=jsonb_set(report,\'{revision}\',\'99\') where run_id=$1', [run.id])
      throw new Error('rollback probe')
    }), /rollback probe/)
    assert.equal((await store.getRun(db, run.roomKey, run.id)).report.revision, 2)
  } finally {
    if (db) await db.end()
    await admin.query(`drop schema if exists ${schema} cascade`)
    await admin.end()
  }
})
