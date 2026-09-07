'use strict'

/**
 * P0 diagnostic: SAFE_LOAD_PARTIAL_CHILDREN
 *
 * 1) Seed >400-node room with PARENT_5/20/50/100
 * 2) Compare room_nodes vs preview?safe=1 child counts
 * 3) Product Editor UI insert via INSERT_CHILD_NODE
 * 4) Classify F5: PG / full / safe_load / editor
 *
 * Does NOT modify Frozen Core.
 */

require('../bin/loadEnv')

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { Pool } = require('pg')

const ORIGIN = String(
  process.env.C2_BROWSER_ORIGIN ||
    process.env.COLLAB_TEST_BASE_URL ||
    process.env.ORIGIN ||
    'http://127.0.0.1:8989'
).replace(/\/$/, '')

const DEV_KEY =
  process.env.AUTH_DEV_BYPASS_KEY ||
  (() => {
    try {
      const line = fs
        .readFileSync(path.resolve(__dirname, '../../.env'), 'utf8')
        .split(/\n/)
        .map(r => r.replace(/\r$/, ''))
        .find(r => r.startsWith('AUTH_DEV_BYPASS_KEY='))
      return line ? line.slice('AUTH_DEV_BYPASS_KEY='.length).trim() : ''
    } catch (_) {
      return ''
    }
  })()

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function countTree(n) {
  if (!n) return 0
  return 1 + (n.children || []).reduce((a, c) => a + countTree(c), 0)
}

function findByText(tree, text) {
  let found = null
  const walk = n => {
    if (!n || found) return
    const t = String((n.data && n.data.text) || '').replace(/<[^>]*>/g, '')
    if (t === text) found = n
    ;(n.children || []).forEach(walk)
  }
  walk(tree)
  return found
}

function findByUid(tree, uid) {
  let found = null
  const walk = n => {
    if (!n || found) return
    if (n.data && n.data.uid === uid) found = n
    ;(n.children || []).forEach(walk)
  }
  walk(tree)
  return found
}

function buildTree() {
  // Single spine so BFS safe_load (~80) spends budget on PARENT_* children,
  // not a competing sibling branch. Extra mass hangs under fill_hub (reached
  // late in BFS) so liveCount >= 400 while PARENT_100 is still clipped.
  const root = {
    data: { uid: 'root', text: 'SAFE_LOAD_P0_ROOT', isRoot: true },
    children: []
  }
  const l1 = { data: { uid: 'a_l1', text: 'L1' }, children: [] }
  const l2 = { data: { uid: 'a_l2', text: 'L2' }, children: [] }
  root.children.push(l1)
  l1.children.push(l2)
  const parents = [
    { uid: 'parent_5', text: 'PARENT_5', n: 5 },
    { uid: 'parent_20', text: 'PARENT_20', n: 20 },
    { uid: 'parent_50', text: 'PARENT_50', n: 50 },
    { uid: 'parent_100', text: 'PARENT_100', n: 100 }
  ]
  for (const p of parents) {
    const node = { data: { uid: p.uid, text: p.text }, children: [] }
    for (let i = 0; i < p.n; i++) {
      node.children.push({
        data: { uid: p.uid + '_c' + i, text: p.text + '_C' + i },
        children: []
      })
    }
    l2.children.push(node)
  }
  const fillHub = { data: { uid: 'fill_hub', text: 'FILL_HUB' }, children: [] }
  l2.children.push(fillHub)
  let i = 0
  while (countTree(root) < 450) {
    fillHub.children.push({
      data: { uid: 'fill_' + i, text: 'FILL_' + i },
      children: []
    })
    i += 1
  }
  return { tree: root, parents, nodeCount: countTree(root) }
}

async function tryPlaywright() {
  try {
    return require('playwright')
  } catch (_) {
    try {
      return require('@playwright/test')
    } catch (err) {
      return null
    }
  }
}

async function installProbes(page) {
  await page.addInitScript(() => {
    const marks = (window.__C2__ = {
      navStart: performance.now(),
      phases: { NAVIGATION_START: performance.now() },
      previewMeta: null,
      renderGate: 8
    })
    const mark = name => {
      marks.phases[name] = performance.now()
    }
    const maybeMarkRender = () => {
      if (marks.phases.ROOM_DATA_READY == null) return false
      if (marks.phases.FIRST_RENDER_COMPLETE != null) return true
      const svg = document.querySelector('#mindMapContainer svg')
      if (!svg) return false
      const n = svg.querySelectorAll('g.smm-node, g[data-uid], .smm-node, text')
        .length
      if (n < marks.renderGate) return false
      mark('FIRST_RENDER_COMPLETE')
      return true
    }
    const origFetch = window.fetch.bind(window)
    window.fetch = async function patched(input, init) {
      const url = String(
        typeof input === 'string' ? input : (input && input.url) || ''
      )
      const isPreview = /\/api\/files\/[^/?#]+\/preview/.test(url)
      const res = await origFetch(input, init)
      if (isPreview) {
        mark('ROOM_DATA_READY')
        try {
          const data = await res.clone().json()
          marks.previewMeta = {
            safeLoad: !!data.safe_load,
            nodeCount: data.node_count,
            clipped: !!data.clipped
          }
          marks.renderGate = 8
        } catch (_) {}
      }
      return res
    }
    const bind = () => {
      let el = document.querySelector('#mindMapContainer')
      while (el) {
        const vue = el.__vue__
        if (vue && vue.mindMap) {
          window.__C2_MINDMAP__ = vue.mindMap
          return true
        }
        el = el.parentElement
      }
      return false
    }
    const obs = new MutationObserver(() => {
      bind()
      maybeMarkRender()
    })
    const start = () => {
      if (document.body) {
        obs.observe(document.body, { childList: true, subtree: true })
        bind()
      } else setTimeout(start, 50)
    }
    start()
    window.__C2_BIND__ = bind
    window.__C2_MAYBE_RENDER__ = maybeMarkRender
  })
}

async function loginDev(page, origin, key) {
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  const apiLogin = await page.evaluate(
    async ({ origin, key }) => {
      const res = await fetch(origin + '/api/auth/dev-login', {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ key })
      })
      const data = await res.json().catch(() => ({}))
      return { ok: res.ok && !!data.authenticated, status: res.status }
    },
    { origin, key }
  )
  if (!apiLogin.ok) return apiLogin
  await page.goto(origin + '/files', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  })
  await page.waitForSelector('.productShell, .editContainer', { timeout: 30000 })
  return { ok: true }
}

async function recoverServiceGate(page, origin) {
  const blocked = await page.evaluate(() => {
    const text = String((document.body && document.body.innerText) || '')
    return /SERVICE_UNAVAILABLE|协作服务未启动/.test(text)
  })
  if (!blocked) return false
  const btn = page.getByRole('button', { name: /重新连接|重试/ })
  if (await btn.count()) await btn.first().click().catch(() => null)
  else await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
  await page
    .waitForSelector('#mindMapContainer, .productShell, .editContainer', {
      timeout: 60000
    })
    .catch(() => null)
  return true
}

async function waitEditor(page, timeoutMs = 120000) {
  await page.waitForSelector('#mindMapContainer', {
    timeout: Math.min(45000, timeoutMs)
  })
  await page.evaluate(() => {
    if (window.__C2_BIND__) window.__C2_BIND__()
  })
  await page
    .waitForFunction(
      () => window.__C2__ && window.__C2__.phases && window.__C2__.phases.ROOM_DATA_READY != null,
      { timeout: Math.min(90000, timeoutMs) }
    )
    .catch(() => null)
  await page.waitForFunction(
    () => {
      if (window.__C2_MAYBE_RENDER__) window.__C2_MAYBE_RENDER__()
      if (window.__C2_BIND__) window.__C2_BIND__()
      return !!(window.__C2_MINDMAP__ && window.__C2_MINDMAP__.renderer)
    },
    { timeout: timeoutMs }
  )
}

async function main() {
  const report = {
    origin: ORIGIN,
    SAFE_LOAD_ACTIVE: null,
    PARTIAL_CHILDREN_DETECTED: null,
    parents: {},
    inserts: [],
    f5: null,
    ROOT_CAUSE: '',
    FREEZE_BREAK_REQUIRED: 'NO',
    LOCAL_P0_FIXED: 'NO',
    recommendation: null
  }

  if (!DEV_KEY) {
    console.log('SAFE_LOAD_PARTIAL: SKIP (no AUTH_DEV_BYPASS_KEY)')
    return
  }
  const pw = await tryPlaywright()
  if (!pw) {
    console.log('SAFE_LOAD_PARTIAL: SKIP (no playwright)')
    return
  }

  const pool = new Pool()
  const { tree, parents, nodeCount } = buildTree()
  const roomKey = 'p0-safeload-' + Date.now()
  const clientId = 'p0-safeload-client'
  report.roomKey = roomKey
  report.seedNodeCount = nodeCount

  const browser = await pw.chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage']
  })
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(120000)
  await installProbes(page)

  try {
    const login = await loginDev(page, ORIGIN, DEV_KEY)
    assert.ok(login.ok, 'dev login failed')

    const request = context.request
    const create = await request.post(ORIGIN + '/api/files', {
      data: {
        room_key: roomKey,
        title: 'P0 SafeLoad Partial',
        clientId,
        tree: {
          data: { text: 'Root', uid: 'root', isRoot: true },
          children: []
        }
      },
      timeout: 120000
    })
    assert.ok(create.ok() || create.status() === 409, 'create failed')

    const replace = await request.post(
      ORIGIN + '/api/files/' + encodeURIComponent(roomKey) + '/replace',
      {
        data: {
          tree,
          allowFullTree: true,
          source: 'p0-safeload-probe',
          clientId,
          type: 'map.replace'
        },
        timeout: 300000
      }
    )
    if (!replace.ok()) {
      throw new Error('replace failed ' + (await replace.text()).slice(0, 500))
    }

    for (const p of parents) {
      const row = await pool.query(
        `select count(*)::int as c from room_nodes
         where room_key=$1 and parent_uid=$2 and deleted_at is null`,
        [roomKey, p.uid]
      )
      report.parents[p.text] = {
        uid: p.uid,
        SERVER_CHILD_COUNT: Number(row.rows[0].c),
        CLIENT_CHILD_COUNT: null,
        SAFE_LOAD_CHILD_COUNT: null
      }
    }

    const previewRes = await request.get(
      ORIGIN +
        '/api/files/' +
        encodeURIComponent(roomKey) +
        '/preview?safe=1'
    )
    assert.ok(previewRes.ok(), 'preview failed')
    const preview = await previewRes.json()
    report.SAFE_LOAD_ACTIVE = !!preview.safe_load
    report.previewTreeNodes = countTree(preview.tree)
    report.previewNodeCountField = preview.node_count
    const previewUids = []
    ;(function walk(n) {
      if (!n || !n.data) return
      previewUids.push({
        uid: n.data.uid,
        text: String(n.data.text || '').slice(0, 40),
        kids: (n.children || []).length,
        childCount: n.data.childCount
      })
      ;(n.children || []).forEach(walk)
    })(preview.tree)
    report.previewSample = previewUids.slice(0, 50)
    console.log(
      'PREVIEW',
      JSON.stringify({
        safe_load: preview.safe_load,
        clipped: preview.clipped,
        node_count: preview.node_count,
        treeNodes: report.previewTreeNodes,
        sample: report.previewSample
      })
    )

    for (const p of parents) {
      const node = findByUid(preview.tree, p.uid) || findByText(preview.tree, p.text)
      const kids = node && Array.isArray(node.children) ? node.children.length : null
      report.parents[p.text].SAFE_LOAD_CHILD_COUNT = kids
      report.parents[p.text].IN_SAFE_LOAD = !!node
      report.parents[p.text].CHILD_COUNT_META =
        node && node.data && node.data.childCount != null
          ? Number(node.data.childCount)
          : null
      console.log(
        'PARENT_COMPARE',
        p.text,
        'SERVER=',
        report.parents[p.text].SERVER_CHILD_COUNT,
        'SAFE_LOAD=',
        kids,
        'META=',
        report.parents[p.text].CHILD_COUNT_META
      )
    }

    // Open editor
    await page.goto(ORIGIN + '/?room=' + encodeURIComponent(roomKey), {
      waitUntil: 'domcontentloaded',
      timeout: 120000
    })
    await recoverServiceGate(page, ORIGIN)
    await recoverServiceGate(page, ORIGIN)
    await waitEditor(page, 120000)
    await wait(1000)

    const safeMode = await page.evaluate(() => {
      const mm = window.__C2_MINDMAP__
      return !!(mm && mm.cooperate && mm.cooperate.safeLoadMode)
    })
    report.SAFE_LOAD_ACTIVE = report.SAFE_LOAD_ACTIVE || safeMode

    for (const p of parents) {
      const info = await page.evaluate(async parentUid => {
        const mm = window.__C2_MINDMAP__
        if (!mm || !mm.renderer || !mm.renderer.root) {
          return { error: 'no_mm' }
        }
        const find = () => {
          const stack = [mm.renderer.root]
          while (stack.length) {
            const cur = stack.pop()
            if (cur.getData && cur.getData('uid') === parentUid) return cur
            ;(cur.children || []).forEach(c => stack.push(c))
          }
          return null
        }
        let node = find()
        if (node && mm.cooperate && mm.cooperate.hydrateFromHttp) {
          try {
            await mm.cooperate.hydrateFromHttp(node)
          } catch (_) {}
          await new Promise(r => setTimeout(r, 400))
          node = find()
        }
        if (!node) return { found: false, CLIENT_CHILD_COUNT: null }
        const kids = (node.nodeData && node.nodeData.children) || []
        return {
          found: true,
          CLIENT_CHILD_COUNT: kids.length,
          CHILD_COUNT_META: Number(node.getData('childCount') || 0),
          safeLoadMode: !!(mm.cooperate && mm.cooperate.safeLoadMode)
        }
      }, p.uid)
      report.parents[p.text].CLIENT_CHILD_COUNT = info.CLIENT_CHILD_COUNT
      report.parents[p.text].EDITOR_FOUND = !!info.found
      report.parents[p.text].EDITOR_META = info.CHILD_COUNT_META
      console.log(
        'EDITOR_COMPARE',
        p.text,
        'SERVER=',
        report.parents[p.text].SERVER_CHILD_COUNT,
        'CLIENT=',
        info.CLIENT_CHILD_COUNT,
        'found=',
        info.found
      )
    }

    report.PARTIAL_CHILDREN_DETECTED = parents.some(p => {
      const row = report.parents[p.text]
      return (
        row.CLIENT_CHILD_COUNT != null &&
        row.CLIENT_CHILD_COUNT < row.SERVER_CHILD_COUNT
      )
    })
      ? 'YES'
      : 'NO'

    // Also detect from safe_load alone if editor fully hydrated some parents
    if (report.PARTIAL_CHILDREN_DETECTED === 'NO') {
      const fromSafe = parents.some(p => {
        const row = report.parents[p.text]
        return (
          row.SAFE_LOAD_CHILD_COUNT != null &&
          row.SAFE_LOAD_CHILD_COUNT < row.SERVER_CHILD_COUNT
        )
      })
      if (fromSafe) {
        report.PARTIAL_CHILDREN_DETECTED = 'YES'
        report.PARTIAL_NOTE =
          'safe_load tree clipped; editor hydrate may have filled some parents'
      }
    }

    // UI inserts — prefer parents still partial in editor; else all
    for (const p of parents) {
      const stamp = Date.now()
      const text = 'TEST_CHILD_' + p.n + '_' + stamp
      const insertResult = await page.evaluate(
        async ({ parentUid, text, roomKey, origin }) => {
          const mm = window.__C2_MINDMAP__
          if (!mm || !mm.renderer || !mm.renderer.root) {
            return { ok: false, error: 'no_mm' }
          }
          const find = () => {
            const stack = [mm.renderer.root]
            while (stack.length) {
              const cur = stack.pop()
              if (cur.getData && cur.getData('uid') === parentUid) return cur
              ;(cur.children || []).forEach(c => stack.push(c))
            }
            return null
          }
          let parent = find()
          // If parent missing from partial tree, fetch subtree (user expand path).
          if (!parent && mm.cooperate && mm.cooperate.httpFetchSubtree) {
            try {
              // Ensure ancestors exist: hydrate L2 first if present.
              const l2 = (() => {
                const stack = [mm.renderer.root]
                while (stack.length) {
                  const cur = stack.pop()
                  if (cur.getData && cur.getData('uid') === 'a_l2') return cur
                  ;(cur.children || []).forEach(c => stack.push(c))
                }
                return null
              })()
              if (l2 && mm.cooperate.hydrateFromHttp) {
                await mm.cooperate.hydrateFromHttp(l2)
                await new Promise(r => setTimeout(r, 400))
              }
            } catch (_) {}
            parent = find()
          }
          if (!parent) {
            // Last resort: HTTP locate + force setData path is out of scope;
            // report missing.
            return { ok: false, error: 'parent_not_in_editor' }
          }

          // Capture pre-hydrate client count (partial semantics).
          const beforeHydrate = (parent.nodeData && parent.nodeData.children) || []
          const beforeHydrateCount = beforeHydrate.length
          const metaBefore = Number(parent.getData('childCount') || 0)

          // Product UX: expand triggers hydrate — but for mismatch repro we
          // insert on whatever children are currently held if meta says "complete".
          const looksComplete =
            metaBefore > 0 && beforeHydrateCount >= metaBefore
          if (!looksComplete && mm.cooperate && mm.cooperate.hydrateFromHttp) {
            try {
              await mm.cooperate.hydrateFromHttp(parent)
            } catch (_) {}
            await new Promise(r => setTimeout(r, 500))
            parent = find() || parent
          }

          try {
            if (typeof parent.setExpand === 'function') parent.setExpand(true)
          } catch (_) {}

          const before = (parent.nodeData && parent.nodeData.children) || []
          const requestedIndex = before.length
          if (mm.renderer.clearActiveNodeList) mm.renderer.clearActiveNodeList()
          if (typeof parent.active === 'function') parent.active()
          else mm.renderer.activeNodeList = [parent]

          try {
            mm.execCommand('INSERT_CHILD_NODE', false, [parent], { text })
          } catch (err) {
            return {
              ok: false,
              error: 'exec_failed:' + String(err && err.message ? err.message : err),
              BEFORE_HYDRATE_COUNT: beforeHydrateCount,
              META_BEFORE: metaBefore,
              CLIENT_BEFORE_COUNT: before.length
            }
          }

          const deadline = Date.now() + 10000
          let newUid = null
          let newIndex = -1
          while (Date.now() < deadline) {
            parent = find() || parent
            const kids = (parent.nodeData && parent.nodeData.children) || []
            const hit = kids.find(
              k =>
                k &&
                k.data &&
                String(k.data.text || '').replace(/<[^>]*>/g, '') === text
            )
            if (hit && hit.data && hit.data.uid) {
              newUid = hit.data.uid
              newIndex = kids.indexOf(hit)
              break
            }
            await new Promise(r => setTimeout(r, 120))
          }
          await new Promise(r => setTimeout(r, 1500))
          parent = find() || parent
          const after = (parent.nodeData && parent.nodeData.children) || []
          return {
            ok: !!newUid,
            newUid,
            text,
            CLIENT_VISIBLE_CHILD_COUNT: after.length,
            CLIENT_REQUESTED_INDEX: requestedIndex,
            CLIENT_BEFORE_COUNT: before.length,
            BEFORE_HYDRATE_COUNT: beforeHydrateCount,
            META_BEFORE: metaBefore,
            NEW_INDEX_IN_CLIENT: newIndex,
            roomKey,
            origin
          }
        },
        { parentUid: p.uid, text, roomKey, origin: ORIGIN }
      )

      let pgRow = null
      if (insertResult.newUid) {
        pgRow = (
          await pool.query(
            `select uid, parent_uid, position, node_version, deleted_at
             from room_nodes where room_key=$1 and uid=$2`,
            [roomKey, insertResult.newUid]
          )
        ).rows[0]
      } else {
        pgRow = (
          await pool.query(
            `select uid, parent_uid, position, node_version, deleted_at
             from room_nodes
             where room_key=$1 and parent_uid=$2 and deleted_at is null
               and regexp_replace(coalesce(data->>'text',''),'<[^>]*>','','g')=$3
             order by updated_at desc nulls last limit 1`,
            [roomKey, p.uid, text]
          )
        ).rows[0]
        if (pgRow) insertResult.newUid = pgRow.uid
      }

      const siblings = (
        await pool.query(
          `select uid, position from room_nodes
           where room_key=$1 and parent_uid=$2 and deleted_at is null
           order by position, uid`,
          [roomKey, p.uid]
        )
      ).rows
      const slot = siblings.findIndex(r => r.uid === insertResult.newUid)
      const op = (
        await pool.query(
          `select version, operation_type, target_id, payload
           from room_operations where room_key=$1
           order by version desc limit 30`,
          [roomKey]
        )
      ).rows.find(
        row =>
          row.operation_type === 'node.insert' &&
          ((row.payload && row.payload.uid) === insertResult.newUid ||
            row.target_id === insertResult.newUid)
      )

      const clientPartial =
        report.parents[p.text].CLIENT_CHILD_COUNT != null &&
        report.parents[p.text].CLIENT_CHILD_COUNT <
          report.parents[p.text].SERVER_CHILD_COUNT

      // Client "append" on a partial list uses index=visibleCount, which the
      // server treats as an absolute slot in the FULL sibling set.
      const intendedAppend =
        insertResult.BEFORE_HYDRATE_COUNT != null &&
        insertResult.CLIENT_REQUESTED_INDEX != null &&
        Number(insertResult.CLIENT_REQUESTED_INDEX) ===
          Number(insertResult.BEFORE_HYDRATE_COUNT)

      const notAtServerEnd =
        slot >= 0 && siblings.length > 0 && slot !== siblings.length - 1

      const mismatch =
        clientPartial && intendedAppend && notAtServerEnd
          ? 'YES'
          : clientPartial &&
              insertResult.CLIENT_REQUESTED_INDEX != null &&
              slot >= 0 &&
              Number(insertResult.CLIENT_REQUESTED_INDEX) !== slot
            ? 'YES'
            : 'NO'

      const entry = {
        parent: p.text,
        parentUid: p.uid,
        text,
        insertResult,
        CLIENT_VISIBLE_CHILD_COUNT: insertResult.CLIENT_VISIBLE_CHILD_COUNT,
        CLIENT_REQUESTED_INDEX: insertResult.CLIENT_REQUESTED_INDEX,
        SERVER_FULL_CHILD_COUNT: siblings.length,
        SERVER_RESOLVED_SLOT: slot,
        PG_AFTER_INSERT: pgRow && !pgRow.deleted_at ? 'PRESENT' : 'MISSING',
        pg: pgRow || null,
        operation: op
          ? {
              type: op.operation_type,
              version: op.version,
              payloadIndex: op.payload && op.payload.index,
              position: op.payload && op.payload.position,
              parentUid:
                (op.payload && (op.payload.parentUid || op.payload.parent)) ||
                null
            }
          : null,
        PARTIAL_SIBLING_INDEX_MISMATCH: mismatch,
        STALE_CHILD_COUNT_META:
          insertResult.META_BEFORE != null &&
          report.parents[p.text].SERVER_CHILD_COUNT != null &&
          Number(insertResult.META_BEFORE) <
            report.parents[p.text].SERVER_CHILD_COUNT
            ? 'YES'
            : 'NO'
      }
      report.inserts.push(entry)
      console.log('INSERT_CASE', JSON.stringify(entry))
    }

    const focus =
      report.inserts.find(
        i => i.parent === 'PARENT_50' && i.PG_AFTER_INSERT === 'PRESENT'
      ) ||
      report.inserts.find(i => i.PARTIAL_SIBLING_INDEX_MISMATCH === 'YES') ||
      report.inserts.find(i => i.parent === 'PARENT_100' && i.pg) ||
      report.inserts.find(i => i.PG_AFTER_INSERT === 'PRESENT')

    if (focus && focus.pg) {
      const uid = focus.pg.uid
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 })
      await recoverServiceGate(page, ORIGIN)
      await waitEditor(page, 120000)
      await wait(1500)

      const pgAfter = (
        await pool.query(
          `select uid from room_nodes
           where room_key=$1 and uid=$2 and deleted_at is null`,
          [roomKey, uid]
        )
      ).rows[0]

      const full = await (
        await request.get(
          ORIGIN +
            '/api/files/' +
            encodeURIComponent(roomKey) +
            '?format=full&max_nodes=10000'
        )
      ).json()
      const safe = await (
        await request.get(
          ORIGIN +
            '/api/files/' +
            encodeURIComponent(roomKey) +
            '/preview?safe=1'
        )
      ).json()

      const inFull = !!(findByUid(full.tree, uid) || findByText(full.tree, focus.text))
      const inSafe = !!(findByUid(safe.tree, uid) || findByText(safe.tree, focus.text))

      const inEditor = await page.evaluate(
        async ({ parentUid, uid, text }) => {
          const mm = window.__C2_MINDMAP__
          if (!mm || !mm.renderer || !mm.renderer.root) {
            return { found: false, reason: 'no_mm' }
          }
          const find = id => {
            const stack = [mm.renderer.root]
            while (stack.length) {
              const cur = stack.pop()
              if (cur.getData && cur.getData('uid') === id) return cur
              ;(cur.children || []).forEach(c => stack.push(c))
            }
            return null
          }
          let parent = find(parentUid)
          if (!parent) return { found: false, reason: 'parent_missing' }
          // After F5, product may need hydrate to see wide children.
          if (mm.cooperate && mm.cooperate.hydrateFromHttp) {
            try {
              await mm.cooperate.hydrateFromHttp(parent)
            } catch (_) {}
            await new Promise(r => setTimeout(r, 600))
            parent = find(parentUid) || parent
          }
          const kids = (parent.nodeData && parent.nodeData.children) || []
          const hit = kids.find(
            k =>
              k &&
              k.data &&
              (k.data.uid === uid ||
                String(k.data.text || '').replace(/<[^>]*>/g, '') === text)
          )
          return {
            found: !!hit,
            clientKids: kids.length,
            reason: hit ? 'ok' : 'missing_after_hydrate'
          }
        },
        { parentUid: focus.parentUid, uid, text: focus.text }
      )

      report.f5 = {
        focusParent: focus.parent,
        uid,
        NEW_NODE_IN_PG: pgAfter ? 'YES' : 'NO',
        NEW_NODE_IN_FULL_TREE: inFull ? 'YES' : 'NO',
        NEW_NODE_IN_SAFE_LOAD: inSafe ? 'YES' : 'NO',
        NEW_NODE_IN_EDITOR: inEditor.found ? 'YES' : 'NO',
        editorDetail: inEditor,
        PARTIAL_SIBLING_INDEX_MISMATCH: focus.PARTIAL_SIBLING_INDEX_MISMATCH
      }

      if (!pgAfter) report.ROOT_CAUSE = 'PERSISTENCE_MISSING'
      else if (focus.PARTIAL_SIBLING_INDEX_MISMATCH === 'YES')
        report.ROOT_CAUSE =
          'PARTIAL_SIBLING_INDEX_MISMATCH (safe_load clipped children + absolute index append)'
      else if (inFull && !inSafe && !inEditor.found)
        report.ROOT_CAUSE = 'SAFE_LOAD_DROP'
      else if (inFull && inSafe && !inEditor.found)
        report.ROOT_CAUSE = 'EDITOR_HYDRATE_DROP'
      else if (!inEditor.found && inFull)
        report.ROOT_CAUSE = 'SAFE_LOAD_OR_HYDRATE_DROP'
      else if (inEditor.found && focus.STALE_CHILD_COUNT_META === 'YES')
        report.ROOT_CAUSE =
          'SAFE_LOAD_PARTIAL_CHILDREN (stale childCount; insert survived F5 hydrate but index was wrong)'
      else if (inEditor.found) report.ROOT_CAUSE = 'NOT_REPRODUCED_ON_FOCUS'
      else report.ROOT_CAUSE = 'UNKNOWN'
    }

    const mismatchAny = report.inserts.some(
      i => i.PARTIAL_SIBLING_INDEX_MISMATCH === 'YES'
    )
    const safeClip = parents.some(p => {
      const row = report.parents[p.text]
      return (
        row.SAFE_LOAD_CHILD_COUNT != null &&
        row.SAFE_LOAD_CHILD_COUNT < row.SERVER_CHILD_COUNT
      )
    })

    if (
      report.PARTIAL_CHILDREN_DETECTED === 'YES' ||
      safeClip ||
      report.ROOT_CAUSE === 'SAFE_LOAD_DROP' ||
      mismatchAny
    ) {
      report.recommendation = {
        preferred: 'C',
        summary:
          'Use sibling anchors (leftSiblingUid/rightSiblingUid or beforeUid/afterUid); server places against room_nodes full sibling set.',
        A: 'Hydrate full direct children before edit — works but expensive for wide parents; does not fix safe_load F5 visibility alone.',
        B: 'Replace absolute index with beforeUid/afterUid — same idea as C; protocol-shaped.',
        C: 'Client sends anchors; server resolves fractional position from authority. Does not raise safe_load caps.',
        FREEZE_BREAK_REQUIRED:
          'LIKELY YES only if node.insert gains anchor fields in Frozen Core; pure client hydrate-before-edit (A) can be NO'
      }
      report.FREEZE_BREAK_REQUIRED =
        report.recommendation.FREEZE_BREAK_REQUIRED
    }

    // Status block
    const p5 = report.parents.PARENT_5
    const p20 = report.parents.PARENT_20
    const p50 = report.parents.PARENT_50
    const p100 = report.parents.PARENT_100
    const last = report.inserts[report.inserts.length - 1]
    const lines = [
      'SAFE_LOAD_ACTIVE = ' + (report.SAFE_LOAD_ACTIVE ? 'YES' : 'NO'),
      'PARTIAL_CHILDREN_DETECTED = ' + report.PARTIAL_CHILDREN_DETECTED,
      'PARENT_5_SERVER = ' + (p5 && p5.SERVER_CHILD_COUNT),
      'PARENT_5_CLIENT = ' + (p5 && p5.CLIENT_CHILD_COUNT),
      'PARENT_20_SERVER = ' + (p20 && p20.SERVER_CHILD_COUNT),
      'PARENT_20_CLIENT = ' + (p20 && p20.CLIENT_CHILD_COUNT),
      'PARENT_50_SERVER = ' + (p50 && p50.SERVER_CHILD_COUNT),
      'PARENT_50_CLIENT = ' + (p50 && p50.CLIENT_CHILD_COUNT),
      'PARENT_100_SERVER = ' + (p100 && p100.SERVER_CHILD_COUNT),
      'PARENT_100_CLIENT = ' + (p100 && p100.CLIENT_CHILD_COUNT),
      'PARENT_5_SAFE_LOAD = ' + (p5 && p5.SAFE_LOAD_CHILD_COUNT),
      'PARENT_20_SAFE_LOAD = ' + (p20 && p20.SAFE_LOAD_CHILD_COUNT),
      'PARENT_50_SAFE_LOAD = ' + (p50 && p50.SAFE_LOAD_CHILD_COUNT),
      'PARENT_100_SAFE_LOAD = ' + (p100 && p100.SAFE_LOAD_CHILD_COUNT),
      'PG_AFTER_INSERT = ' + (last ? last.PG_AFTER_INSERT : 'N/A'),
      'NEW_NODE_IN_PG = ' + (report.f5 ? report.f5.NEW_NODE_IN_PG : 'N/A'),
      'NEW_NODE_IN_FULL_TREE = ' +
        (report.f5 ? report.f5.NEW_NODE_IN_FULL_TREE : 'N/A'),
      'NEW_NODE_IN_SAFE_LOAD = ' +
        (report.f5 ? report.f5.NEW_NODE_IN_SAFE_LOAD : 'N/A'),
      'NEW_NODE_IN_EDITOR = ' +
        (report.f5 ? report.f5.NEW_NODE_IN_EDITOR : 'N/A'),
      'PARTIAL_SIBLING_INDEX_MISMATCH = ' +
        (report.f5
          ? report.f5.PARTIAL_SIBLING_INDEX_MISMATCH
          : mismatchAny
            ? 'YES'
            : 'NO'),
      'ROOT_CAUSE = ' + (report.ROOT_CAUSE || 'UNSET'),
      'FREEZE_BREAK_REQUIRED = ' + String(report.FREEZE_BREAK_REQUIRED),
      'LOCAL_P0_FIXED = ' + report.LOCAL_P0_FIXED,
      'RECOMMENDED_FIX = ' +
        ((report.recommendation && report.recommendation.preferred) || 'NONE')
    ]
    console.log('\n=== SAFE_LOAD_PARTIAL_CHILDREN STATUS ===')
    console.log(lines.join('\n'))

    const outDir = path.join(__dirname, 'reports')
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(
      path.join(outDir, 'p0-safeload-partial.json'),
      JSON.stringify(report, null, 2)
    )
    console.log('wrote test/reports/p0-safeload-partial.json')
  } finally {
    await browser.close().catch(() => {})
    await pool.end().catch(() => {})
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
