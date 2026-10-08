// Uses a temporary schema only; no existing users, sessions or business data are changed.
require('../bin/loadEnv')
const assert = require('assert')
const crypto = require('crypto')
const { Pool } = require('pg')
const sso = require('../bin/cogneeSso')

async function run() {
  const schema = `test_cognee_sso_${crypto.randomBytes(8).toString('hex')}`
  const connection = {
    host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 15432),
    database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD
  }
  const admin = new Pool(connection)
  const pool = new Pool({ ...connection, options: `-c search_path=${schema}`, max: 4 })
  const otherProcess = new Pool({ ...connection, options: `-c search_path=${schema}` })
  try {
    await admin.query(`create schema ${schema}`)
    await pool.query(`create table wecom_users (
      user_id text primary key, corp_id text, wecom_userid text, name text
    )`)
    await pool.query(`insert into wecom_users values ('one', 'ww-test', 'member-1', '测试成员')`)
    await sso.initStore(pool)
    const config = sso.readConfig({
      MIND_MAP_COGNEE_SSO_SECRET: 'test-secret-'.repeat(4),
      COGNEE_SSO_REDIRECT_URI: 'https://xx.stillgroup.net:3030/sso/mind-map/callback'
    })
    const user = { id: 'one', corpId: 'ww-test', wecomUserId: 'member-1' }
    const verifier = crypto.randomBytes(64).toString('base64url')
    const issue = () => sso.issueCode(pool, user, sso.sha256(verifier), config.redirectUri)
    const payload = code => ({ code, code_verifier: verifier, redirect_uri: config.redirectUri })
    const code = await issue()
    const stored = (await pool.query('select * from auth_cognee_codes')).rows[0]
    assert.notEqual(stored.code_hash, code)
    assert.equal(stored.code_hash, sso.sha256(code))
    await assert.rejects(sso.consumeCode(pool, { ...payload(code), code_verifier: 'x'.repeat(86) }, config))
    await assert.rejects(sso.consumeCode(pool, { ...payload(code), redirect_uri: 'https://evil.invalid' }, config))
    // A second pool redeems it: no in-process code storage or sticky sessions.
    const profile = await sso.consumeCode(otherProcess, payload(code), config)
    assert.deepEqual(profile, {
      sub: 'wecom:ww-test:member-1', corp_id: 'ww-test', wecom_userid: 'member-1', name: '测试成员'
    })
    await assert.rejects(sso.consumeCode(pool, payload(code), config))
    const concurrentCode = await issue()
    const results = await Promise.allSettled([
      sso.consumeCode(pool, payload(concurrentCode), config),
      sso.consumeCode(otherProcess, payload(concurrentCode), config)
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const expired = await issue()
    await pool.query("update auth_cognee_codes set expires_at = now() - interval '1 second'")
    await assert.rejects(sso.consumeCode(pool, payload(expired), config))
    await assert.rejects(sso.issueCode(pool, { id: 'one' }, sso.sha256(verifier), config.redirectUri))
    console.log('cognee SSO PostgreSQL tests passed (PKCE, expiry, replay, concurrent redemption, cross-process storage)')
  } finally {
    await pool.end()
    await otherProcess.end()
    await admin.query(`drop schema if exists ${schema} cascade`)
    await admin.end()
  }
}

run().catch(error => { console.error(error); process.exitCode = 1 })
