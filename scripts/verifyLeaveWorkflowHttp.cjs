// Full collabServer, real session cookies, SSE, trusted graph writer, disposable DB.
const assert = require('node:assert/strict')
const { execFileSync, spawn } = require('node:child_process')
const { randomUUID, randomBytes, createHash } = require('node:crypto')
const http = require('node:http'),
  path = require('node:path')
const { Client } = require('../simple-mind-map/node_modules/pg')
const core = require('../simple-mind-map/bin/leaveWorkflow/core')
const source = {
  roomKey: 'room-yk3tz4aj',
  nodeUid: '1f580e83-3ced-43da-9f52-1e72f68992e0'
}
const wait = ms => new Promise(r => setTimeout(r, ms))
async function main() {
  assert.equal(process.env.LEAVE_TEST_DISPOSABLE, '1')
  const container = process.env.LEAVE_TEST_DB_CONTAINER
  assert.ok(container && /preview|test/.test(container))
  const info = JSON.parse(
    execFileSync('docker', ['inspect', container], { encoding: 'utf8' })
  )[0]
  const env = Object.fromEntries(
    info.Config.Env.map(s => [
      s.slice(0, s.indexOf('=')),
      s.slice(s.indexOf('=') + 1)
    ])
  )
  const cfg = {
    host: '127.0.0.1',
    port: Number(info.NetworkSettings.Ports['5432/tcp'][0].HostPort),
    database: env.POSTGRES_DB || env.POSTGRES_USER || 'postgres',
    user: env.POSTGRES_USER || 'postgres',
    password: env.POSTGRES_PASSWORD
  }
  const admin = new Client(cfg)
  await admin.connect()
  const database = 'leave_http_' + process.pid + '_' + Date.now()
  await admin.query(`create database ${database}`)
  const db = new Client({ ...cfg, database })
  const socket = http.createServer()
  await new Promise(r => socket.listen(0, '127.0.0.1', r))
  const port = socket.address().port
  await new Promise(r => socket.close(r))
  const base = 'http://127.0.0.1:' + port,
    sharedToken = randomBytes(32).toString('hex')
  const child = spawn(
    process.execPath,
    ['simple-mind-map/bin/collabServer.js'],
    {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MIND_MAP_SKIP_ROOT_ENV: '1',
        HOST: '127.0.0.1',
        PORT: String(port),
        COLLAB_V2: '1',
        COLLAB_EVENT_BUS: 'memory',
        PGHOST: cfg.host,
        PGPORT: String(cfg.port),
        PGDATABASE: database,
        PGUSER: cfg.user,
        PGPASSWORD: cfg.password,
        WECOM_AUTH_ENABLED: 'true',
        WECOM_CORP_ID: 'wwleaverequesttest',
        WECOM_AGENT_ID: '1000002',
        WECOM_SECRET: 'unused-local-test-secret',
        WECOM_REDIRECT_URI: base + '/api/auth/wecom/callback',
        AUTH_APP_ORIGIN: base,
        AUTH_ALLOWED_ORIGINS: base,
        AUTH_SESSION_SECRET: randomBytes(32).toString('hex'),
        AUTH_COOKIE_SECURE: 'false',
        ONEID_AUTH_ENABLED: 'false',
        WORKBUDDY_AUTH_ENABLED: 'false',
        KNOWLEDGE_COMPILER_ENABLED: 'false',
        TENCENT_COS_SECRET_ID: '',
        TENCENT_COS_SECRET_KEY: '',
        TENCENT_COS_BUCKET: '',
        MCP_TOKEN: sharedToken,
        WCPD_LEAVE_TEMPLATE_ROOM: source.roomKey,
        WCPD_LEAVE_TEMPLATE_NODE: source.nodeUid
      }
    }
  )
  let log = '',
    connected = false,
    assertions = 0,
    streams = []
  child.stdout.on('data', b => {
    log = (log + b).slice(-18000)
  })
  child.stderr.on('data', b => {
    log = (log + b).slice(-18000)
  })
  const check = (a, b, message) => {
    assert.deepEqual(a, b, message)
    assertions++
  }
  const tokens = Object.fromEntries(
    [
      'owner',
      'applicant',
      'manager',
      'ssc',
      'replacement',
      'ceo',
      'vp',
      'hr',
      'other'
    ].map(id => [id, randomBytes(32).toString('base64url')])
  )
  const api = async (id, url, method = 'GET', body) => {
    const response = await fetch(base + url, {
      method,
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        ...(id && id.startsWith('mcp:')
          ? {
              Authorization:
                'Bearer ' +
                require('../simple-mind-map/bin/mcpUserToken').issueMcpUserToken(
                  id.slice(4),
                  sharedToken
                )
            }
          : id === 'shared'
          ? { Authorization: 'Bearer ' + sharedToken }
          : id
          ? { Cookie: 'mind_map_session=' + tokens[id] }
          : {})
      },
      body: body ? JSON.stringify(body) : undefined
    })
    return { status: response.status, data: await response.json() }
  }
  const item = async (...args) => {
    const r = await api(...args)
    assert.equal(r.status, 200, JSON.stringify(r.data))
    return r.data.item
  }
  try {
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null)
        throw new Error('Collab test server exited: ' + log)
      try {
        if ((await fetch(base + '/api/health')).ok) break
      } catch (_) {
        /* startup */
      }
      await wait(100)
    }
    await db.connect()
    connected = true
    for (const [id, token] of Object.entries(tokens)) {
      await db.query(
        "insert into wecom_users(user_id,corp_id,wecom_userid,name,departments) values($1,'wwleaverequesttest',$1,$1,'[1]')",
        [id]
      )
      await db.query(
        "insert into auth_sessions(token_hash,user_id,expires_at,absolute_expires_at) values($1,$2,now()+interval '1 hour',now()+interval '1 hour')",
        [
          createHash('sha256')
            .update(token)
            .digest('hex'),
          id
        ]
      )
    }
    const nodes = structuredClone(
      require('./fixtures/leave-template-verified.json')
    )
    const childNode = (parent, text) =>
      nodes.find(
        n => n.parent_uid === parent && core.label(n.data.text) === text
      )
    const config = childNode(source.nodeUid, '审批配置'),
      cc = childNode(config.uid, '抄送')
    for (const [parent, role, id] of [
      [config.uid, '部门负责人', 'manager'],
      [config.uid, 'SSC', 'ssc'],
      ...['总经理', '副总', '人事组', '部门负责人'].map((r, i) => [
        cc.uid,
        r,
        ['ceo', 'vp', 'hr', 'manager'][i]
      ])
    ])
      nodes.push({
        uid: randomUUID(),
        parent_uid: childNode(parent, role).uid,
        position: 'A',
        data: { text: '账号：' + id }
      })
    const tree = uid => ({
      data: { uid, ...nodes.find(n => n.uid === uid).data },
      children: nodes
        .filter(n => n.parent_uid === uid)
        .sort((a, b) => a.position.localeCompare(b.position))
        .map(n => tree(n.uid))
    })
    for (const [room, owner, graph] of [
      [source.roomKey, 'owner', tree(source.nodeUid)],
      [
        'personal',
        'applicant',
        { data: { uid: 'anchor', text: '我要请假' }, children: [] }
      ]
    ]) {
      await db.query(
        'insert into rooms(room_key,title,cos_key,owner_id,nodes) values($1,$1,$2,$3,$4)',
        [room, 'test/' + room, owner, graph]
      )
      await db.query(
        "insert into room_members(room_key,user_id,role,direct_role) values($1,$2,'owner','owner')",
        [room, owner]
      )
    }
    await db.query(
      "insert into room_members(room_key,user_id,role,direct_role) values($1,'applicant','viewer','viewer')",
      [source.roomKey]
    )
    for (const n of nodes)
      await db.query(
        'insert into room_nodes(room_key,uid,parent_uid,position,data,is_root) values($1,$2,$3,$4,$5,$6)',
        [
          source.roomKey,
          n.uid,
          n.uid === source.nodeUid ? null : n.parent_uid,
          n.position,
          n.data,
          n.uid === source.nodeUid
        ]
      )
    await db.query(
      "insert into room_nodes(room_key,uid,parent_uid,position,data,is_root) values('personal','anchor',null,'A','{\"text\":\"我要请假\"}',true)"
    )
    check((await api(null, '/api/leave-template')).status, 401)
    check(
      (
        await api('shared', '/api/leave-requests', 'POST', {
          roomKey: 'personal',
          nodeUid: 'anchor'
        })
      ).data.code,
      'PERSONAL_IDENTITY_REQUIRED'
    )
    const tpl = await item('owner', '/api/leave-template')
    check(tpl.canPublish, true)
    await item('owner', '/api/leave-template/publish', 'POST', {
      expectedFingerprint: tpl.fingerprint,
      operationId: randomUUID()
    })
    let request = await item('applicant', '/api/leave-requests', 'POST', {
      roomKey: 'personal',
      nodeUid: 'anchor'
    })
    check(
      (await api('manager', '/api/leave-requests/' + request.id)).status,
      404,
      'draft privacy on real HTTP'
    )
    check(
      (
        await item('mcp:applicant', '/api/leave-requests', 'POST', {
          roomKey: 'personal',
          nodeUid: 'anchor'
        })
      ).id,
      request.id,
      'real personal MCP identity reuses its own draft'
    )
    const act = async (actor, action, extra) => {
      request = await item(
        actor,
        '/api/leave-requests/' + request.id + '/' + action,
        'POST',
        {
          expectedRevision: request.revision,
          operationId: randomUUID(),
          ...extra
        }
      )
      return request
    }
    const nodeFields = {
      leaveType: '事假',
      start: '2026-10-22T09:00',
      end: '2026-10-22T11:00',
      replacementId: 'replacement',
      reason: '真实HTTP与身份校验，已交接',
      attachmentIds: []
    }
    // Fixture only writes the user-entered node values; real HTTP imports and validates them.
    for (const [key, value] of Object.entries(nodeFields)) {
      if (key === 'attachmentIds') continue
      await db.query(
        "update room_nodes set data=jsonb_build_object('text',$3::text) where room_key=$1 and uid=$2",
        ['personal', core.projectionId(request.id + ':value:' + key), value]
      )
    }
    check(
      (
        await api(
          'applicant',
          '/api/leave-requests/' + request.id + '/import',
          'POST',
          {
            expectedRevision: request.revision,
            operationId: randomUUID(),
            expectedFields: { ...nodeFields, reason: '尚未同步' }
          }
        )
      ).data.code,
      'NODE_DATA_PENDING'
    )
    await act('applicant', 'import', { expectedFields: nodeFields })
    check(
      request.fields.reason,
      nodeFields.reason,
      'real HTTP reads graph values'
    )
    check(request.report.hours, 2, 'node values calculate two working hours')
    // Wait for the same production projection worker to persist empty field nodes.
    for (let i = 0; i < 50; i++) {
      if (
        (
          await db.query(
            "select 1 from room_nodes where room_key='personal' and data->>'text'='申请资料'"
          )
        ).rows.length
      )
        break
      await wait(100)
    }
    check(
      (
        await db.query(
          "select count(*)::int n from room_nodes where room_key='personal' and data->>'text'='申请资料'"
        )
      ).rows[0].n,
      1,
      'trusted writer projects child fields'
    )
    const controller = new AbortController()
    streams.push(controller)
    const response = await fetch(
      base + '/api/notifications/access-requests/events',
      {
        headers: { Cookie: 'mind_map_session=' + tokens.manager, Origin: base },
        signal: controller.signal
      }
    )
    check(response.status, 200)
    const reader = response.body.getReader(),
      decoder = new TextDecoder()
    let received = decoder.decode((await reader.read()).value)
    check(received.includes('ready'), true)
    // The LISTEN connection emits one initial invalidation after it is established.
    while (!received.includes('invalidate'))
      received += decoder.decode((await reader.read()).value)
    await act('applicant', 'submit', {
      confirmSubmission: true,
      nodeSource: true,
      expectedNodeHash: request.report.nodeInputHash
    })
    const timeout = setTimeout(() => controller.abort(), 3000)
    const invalidation = decoder.decode((await reader.read()).value)
    clearTimeout(timeout)
    check(
      invalidation.includes('invalidate'),
      true,
      'submitted leave emits real SSE invalidation'
    )
    check((await item('manager', '/api/leave-notifications')).unread, 1)
    check((await item('manager', '/api/leave-requests?scope=todo')).total, 1)
    check((await item('ssc', '/api/leave-requests?scope=todo')).total, 0)
    check((await api('other', '/api/leave-requests/' + request.id)).status, 404)
    check(
      (
        await api(
          'mcp:manager',
          '/api/leave-requests/' + request.id + '/decide',
          'POST',
          {
            expectedRevision: request.revision,
            operationId: randomUUID(),
            decision: 'approve',
            reason: 'AI不能代批'
          }
        )
      ).data.code,
      'HUMAN_DECISION_REQUIRED'
    )
    for (const actor of ['manager', 'ssc']) {
      const current = request.steps[request.current_step]
      await act(actor, 'decide', {
        decision: 'approve',
        reason: '真实登录身份逐项核验，其他假种不适用',
        checkedCriteria: current.criteria.map(c => c.uid)
      })
    }
    check(request.status, 'approved')
    check((await item('manager', '/api/leave-requests?scope=history')).total, 1)
    check((await item('ceo', '/api/leave-requests?scope=cc')).total, 1)
    check((await item('ceo', '/api/leave-requests?scope=todo')).total, 0)
    const notices = await item('applicant', '/api/leave-notifications')
    check(
      notices.list.some(n => n.kind === 'approved'),
      true
    )
    await item('applicant', '/api/leave-notifications', 'POST', {
      ids: notices.list.map(n => n.id)
    })
    check((await item('applicant', '/api/leave-notifications')).unread, 0)
    // Trigger and observe the actual trusted operation writer; no fixture writer here.
    for (let i = 0; i < 100; i++) {
      const row = (
        await db.query(
          'select data from room_nodes where room_key=$1 and uid=$2',
          ['personal', core.projectionId(request.id)]
        )
      ).rows[0]
      if (row && row.data.text === '请假申请：已通过') {
        check(row.data.hyperlink, '/?room=personal&leaveRequest=' + request.id)
        break
      }
      await item('applicant', '/api/leave-requests/' + request.id)
      await wait(100)
    }
    check(
      (
        await db.query(
          "select data->>'text' text from room_nodes where room_key=$1 and uid=$2",
          ['personal', core.projectionId(request.id)]
        )
      ).rows[0].text,
      '请假申请：已通过'
    )
    // A second workflow in a separate source room, through the registered MCP
    // tool adapter and real HTTP/database/command writer (only auth is a fixture).
    const generic = require('./fixtures/approval-templates.cjs').template(
      'channel',
      'http-channel'
    )
    const genericTree = uid => ({
      data: { ...generic.nodes.find(n => n.uid === uid).data, uid },
      children: generic.nodes
        .filter(n => n.parent_uid === uid)
        .map(n => genericTree(n.uid))
    })
    for (const [room, owner, graph] of [
      ['http-policy', 'owner', genericTree(generic.root)],
      [
        'http-personal',
        'applicant',
        { data: { uid: 'generic-anchor', text: '我要关停渠道' }, children: [] }
      ]
    ]) {
      await db.query(
        'insert into rooms(room_key,title,cos_key,owner_id,nodes) values($1,$1,$2,$3,$4)',
        [room, 'test/' + room, owner, graph]
      )
      await db.query(
        "insert into room_members(room_key,user_id,role,direct_role) values($1,$2,'owner','owner')",
        [room, owner]
      )
    }
    await db.query(
      "insert into room_members(room_key,user_id,role,direct_role) values('http-policy','applicant','viewer','viewer')"
    )
    for (const n of generic.nodes)
      await db.query(
        'insert into room_nodes(room_key,uid,parent_uid,position,data,is_root) values($1,$2,$3,$4,$5,$6)',
        [
          'http-policy',
          n.uid,
          n.parent_uid,
          n.position,
          n.data,
          n.uid === generic.root
        ]
      )
    await db.query(
      "insert into room_nodes(room_key,uid,parent_uid,position,data,is_root) values('http-personal','generic-anchor',null,'A','{\"text\":\"我要关停渠道\"}',true)"
    )
    check(
      (
        await api('applicant', '/api/workflow-requests', 'POST', {
          roomKey: 'http-personal',
          nodeUid: 'generic-anchor'
        })
      ).data.code,
      'SOURCE_REQUIRED'
    )
    check(
      (await api('applicant', '/api/workflow-template')).data.code,
      'SOURCE_REQUIRED'
    )
    const sourceGeneric = { roomKey: 'http-policy', nodeUid: generic.root }
    const policyGeneric = await item(
      'owner',
      '/api/workflow-template?' +
        new URLSearchParams({
          source_room: sourceGeneric.roomKey,
          source_node: sourceGeneric.nodeUid
        })
    )
    check(policyGeneric.kind, 'generic')
    await item('owner', '/api/workflow-template/publish', 'POST', {
      source: sourceGeneric,
      expectedFingerprint: policyGeneric.fingerprint,
      operationId: randomUUID()
    })
    const { registerApprovalTools } = await import(
      '../simple-mind-map/bin/leaveWorkflow/mcp.mjs'
    )
    const { z } = require('../simple-mind-map/node_modules/zod')
    let toolSchema, toolHandler
    registerApprovalTools(
      {
        tool(name, _description, schema, handler) {
          check(name, 'approval_request')
          toolSchema = z.object(schema)
          toolHandler = handler
        }
      },
      {
        api: async (path, options = {}) =>
          item(
            'mcp:applicant',
            path,
            options.method,
            options.body ? JSON.parse(options.body) : undefined
          ),
        z,
        ok: v => v,
        fail: e => ({ isError: true, error: e.message })
      }
    )
    const call = input => toolHandler(toolSchema.parse(input))
    const match = await call({ action: 'resolve', text: '我要关停渠道' })
    check(match.candidates.length, 1)
    check(match.candidates[0].source, sourceGeneric)
    check(
      toolSchema.safeParse({ action: 'decide' }).success,
      false,
      'MCP does not expose formal decisions'
    )
    const noSource = await call({
      action: 'prepare',
      room_key: 'http-personal',
      node_uid: 'generic-anchor'
    })
    check(
      noSource.isError,
      true,
      'generic MCP prepare cannot fall back silently to leave'
    )
    const prepared = await call({
      action: 'prepare',
      room_key: 'http-personal',
      node_uid: 'generic-anchor',
      template_source: { room_key: 'http-policy', node_uid: generic.root }
    })
    check(prepared.source, sourceGeneric)
    let g = await item(
      'applicant',
      '/api/workflow-requests/' + prepared.request_id
    )
    check(g.template.fields.length, 4)
    const values = {
      渠道名称: '测试渠道A',
      申请措施: '关停',
      预计日期: '2026-10-26',
      库存及结款说明: '隔离验证：无真实库存或资金操作'
    }
    for (const f of g.template.fields)
      await db.query(
        "update room_nodes set data=jsonb_build_object('text',$3::text) where room_key=$1 and uid=$2",
        [
          'http-personal',
          core.projectionId(g.id + ':value:' + f.key),
          values[f.label]
        ]
      )
    const imported = await call({
      action: 'import',
      request_id: g.id,
      expected_revision: g.revision,
      operation_id: randomUUID()
    })
    check(imported.validation.blockers, [])
    const submitted = await call({
      action: 'submit',
      request_id: g.id,
      expected_revision: imported.revision,
      expected_node_hash: imported.validation.nodeInputHash,
      operation_id: randomUUID(),
      confirm_submission: true
    })
    check(submitted.status, 'pending')
    g = await item('manager', '/api/workflow-requests/' + g.id)
    g = await item(
      'manager',
      '/api/workflow-requests/' + g.id + '/decide',
      'POST',
      {
        expectedRevision: g.revision,
        operationId: randomUUID(),
        decision: 'approve',
        reason: '隔离测试：已按渠道模板核对全部要点',
        checkedCriteria: g.steps[0].criteria.map(c => c.uid)
      }
    )
    check(g.status, 'approved')
    check(
      (await item('applicant', '/api/workflow-requests/' + g.id)).history.some(
        e => e.action === 'decide'
      ),
      true
    )
    console.log(
      JSON.stringify({
        ok: true,
        assertions,
        databaseIsolation: true,
        tests: [
          'real collabServer boot/migrations',
          'cookie/session identity',
          'anonymous/shared-token denial',
          'private draft',
          'HTTP flow',
          'real SSE notification',
          'persistent history/CC',
          'trusted graph projection',
          'distributed generic templates',
          'registered generic MCP over real HTTP'
        ]
      })
    )
  } finally {
    streams.forEach(s => s.abort())
    child.kill('SIGTERM')
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve()
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 3000)
      child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
    if (connected) await db.end()
    await admin.query(
      'select pg_terminate_backend(pid) from pg_stat_activity where datname=$1',
      [database]
    )
    await admin.query(`drop database ${database}`)
    await admin.end()
  }
}
main().catch(e => {
  console.error(e.message)
  process.exitCode = 1
})
