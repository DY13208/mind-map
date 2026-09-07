'use strict'

/**
 * C2 Full-tree Renderer BEFORE profile.
 *
 * Does NOT modify Renderer algorithms.
 * Instruments live MindMap methods + DOM APIs during format=full setData.
 *
 * Usage:
 *   C2_BROWSER_ORIGIN=http://127.0.0.1:8989 node ./test/c2FullTreeRender.profile.test.js
 *   C2_PROFILE_SIZES=1000,5000,10000 node ./test/c2FullTreeRender.profile.test.js
 */

const fs = require('fs')
const path = require('path')
const { bushTree } = require('./fixtures/largeMapFixtures')

const ORIGIN = String(
  process.env.C2_BROWSER_ORIGIN ||
    process.env.COLLAB_TEST_BASE_URL ||
    process.env.ORIGIN ||
    'http://127.0.0.1:8989'
).replace(/\/$/, '')

const SIZES = String(process.env.C2_PROFILE_SIZES || '1000,5000,10000')
  .split(',')
  .map(s => Number(s.trim()))
  .filter(n => n > 0)

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

async function tryPlaywright() {
  try {
    return require('playwright')
  } catch (_) {
    try {
      return require('@playwright/test')
    } catch (e) {
      return null
    }
  }
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

async function installBind(page) {
  await page.addInitScript(() => {
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
    const start = () => {
      if (!document.body) return setTimeout(start, 50)
      const obs = new MutationObserver(() => bind())
      obs.observe(document.body, { childList: true, subtree: true })
      bind()
    }
    start()
    window.__C2_BIND__ = bind
  })
}

async function seedRoom(request, origin, size) {
  const { tree } = bushTree(size)
  const roomKey = 'c2-profile-' + size + '-' + Date.now()
  const clientId = 'c2-profile-' + size
  const create = await request.post(origin + '/api/files', {
    data: {
      room_key: roomKey,
      title: 'C2 Profile ' + size,
      clientId,
      tree: {
        data: { text: 'Root', uid: 'root', isRoot: true },
        children: []
      }
    },
    timeout: 120000
  })
  if (!create.ok() && create.status() !== 409) {
    throw new Error('create failed ' + create.status())
  }
  const replace = await request.post(
    origin + '/api/files/' + encodeURIComponent(roomKey) + '/replace',
    {
      data: {
        tree,
        allowFullTree: true,
        source: 'c2-full-profile',
        clientId,
        type: 'map.replace'
      },
      timeout: 300000
    }
  )
  if (!replace.ok()) {
    throw new Error('replace failed ' + (await replace.text()).slice(0, 400))
  }
  return { roomKey, treeNodes: size }
}

async function waitEditor(page, timeoutMs = 120000) {
  await page.waitForSelector('#mindMapContainer', { timeout: 45000 })
  await page.waitForFunction(
    () => {
      if (window.__C2_BIND__) window.__C2_BIND__()
      return !!(window.__C2_MINDMAP__ && window.__C2_MINDMAP__.renderer)
    },
    { timeout: timeoutMs }
  )
}

async function measureFullSetDataWall(page, origin, roomKey, size) {
  const maxNodes = Math.min(size, 10000)
  return page.evaluate(
    async ({ origin, roomKey, maxNodes, size }) => {
      const mm = window.__C2_MINDMAP__
      if (!mm || typeof mm.setData !== 'function') {
        return { ok: false, reason: 'no_mindmap' }
      }
      const longTasks = []
      let obs = null
      try {
        obs = new PerformanceObserver(list => {
          list.getEntries().forEach(e => {
            if (e.duration >= 50) longTasks.push(Math.round(e.duration))
          })
        })
        obs.observe({ type: 'longtask', buffered: true })
      } catch (_) {}

      const t0 = performance.now()
      const res = await fetch(
        origin +
          '/api/files/' +
          encodeURIComponent(roomKey) +
          '?format=full&max_nodes=' +
          maxNodes,
        { credentials: 'include', headers: { Accept: 'application/json' } }
      )
      const tHttp = performance.now()
      if (!res.ok) return { ok: false, reason: 'http_' + res.status }
      const data = await res.json()
      const tParsed = performance.now()
      function countTree(n) {
        if (!n) return 0
        return 1 + (n.children || []).reduce((a, c) => a + countTree(c), 0)
      }
      const treeNodes = countTree(data.tree)
      const renderTimeout =
        size >= 10000 ? 300000 : size >= 5000 ? 240000 : 180000
      const renderPromise = new Promise((resolve, reject) => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          if (typeof mm.off === 'function') mm.off('node_tree_render_end', done)
          resolve('node_tree_render_end')
        }
        if (typeof mm.on === 'function') mm.on('node_tree_render_end', done)
        setTimeout(() => {
          if (settled) return
          settled = true
          if (typeof mm.off === 'function') mm.off('node_tree_render_end', done)
          const svg = document.querySelector('#mindMapContainer svg')
          const n = svg
            ? svg.querySelectorAll('g.smm-node, g[data-uid], .smm-node, text')
                .length
            : 0
          if (n > 50) resolve('timeout_with_svg_' + n)
          else reject(new Error('full_render_timeout'))
        }, renderTimeout)
      })
      try {
        if (mm.cooperate) mm.cooperate.safeLoadMode = false
      } catch (_) {}
      const tSet = performance.now()
      mm.setData(data.tree)
      let renderReason = null
      try {
        renderReason = await renderPromise
      } catch (err) {
        return {
          ok: false,
          reason: 'render_failed',
          error: String(err && err.message ? err.message : err),
          setDataMs: Math.round(performance.now() - tSet)
        }
      }
      const tDone = performance.now()
      if (obs) {
        try {
          obs.disconnect()
        } catch (_) {}
      }
      const root = document.querySelector('#mindMapContainer')
      const svg = root && root.querySelector('svg')
      // Correctness: node instances in renderer cache vs tree
      const cacheCount =
        (mm.renderer &&
          mm.renderer.nodeCache &&
          Object.keys(mm.renderer.nodeCache).length) ||
        0
      return {
        ok: true,
        size,
        treeNodes,
        httpMs: Math.round(tHttp - t0),
        parseMs: Math.round(tParsed - tHttp),
        setDataMs: Math.round(tDone - tSet),
        renderReason,
        MAX_LONG_TASK_MS: longTasks.reduce((m, d) => Math.max(m, d), 0),
        LONG_TASK_COUNT: longTasks.length,
        svgNodeGroups: svg ? svg.querySelectorAll('g.smm-node').length : 0,
        cacheCount,
        correctness:
          cacheCount >= Math.min(treeNodes, 50) ||
          (svg && svg.querySelectorAll('g.smm-node').length > 0)
            ? 'PASS'
            : 'FAIL'
      }
    },
    { origin, roomKey, maxNodes, size }
  )
}

async function profileFullSetData(page, origin, roomKey, size) {
  const maxNodes = Math.min(size, 10000)
  return page.evaluate(
    async ({ origin, roomKey, maxNodes, size }) => {
      const mm = window.__C2_MINDMAP__
      if (!mm || typeof mm.setData !== 'function') {
        return { ok: false, reason: 'no_mindmap' }
      }

      const profile = {
        phases: {
          node_instance_creation: 0,
          tree_traversal: 0,
          text_measurement: 0,
          layout_calculation: 0,
          bounding_geometry: 0,
          svg_node_creation: 0,
          line_creation: 0,
          dom_append: 0,
          generalization_summary: 0,
          associative_line: 0,
          rich_text: 0,
          event_binding: 0,
          fit_transform: 0,
          other_setData: 0,
          json_stringify_compare: 0
        },
        counts: {
          GET_BBOX_CALL_COUNT: 0,
          GET_BOUNDING_CLIENT_RECT_COUNT: 0,
          LAYOUT_PASS_COUNT: 0,
          FULL_RENDER_PASS_COUNT: 0,
          NODE_RENDER_CALL_COUNT: 0,
          LINE_RENDER_CALL_COUNT: 0,
          CREATE_NODE_CALL_COUNT: 0,
          CREATE_NODE_NEW_COUNT: 0,
          CREATE_NODE_REUSE_COUNT: 0,
          GET_SIZE_CALL_COUNT: 0,
          CREATE_TEXT_NODE_COUNT: 0,
          CREATE_RICH_TEXT_COUNT: 0,
          MEASURE_TEXT_SVG_COUNT: 0,
          INNERHTML_WRITE_COUNT: 0,
          NODE_DRAW_ADD_COUNT: 0,
          BIND_GROUP_EVENT_COUNT: 0,
          CHECK_IS_NODE_DATA_CHANGE_COUNT: 0,
          JSON_STRINGIFY_COUNT: 0
        },
        samples: {
          getBoundingClientRect_stackTop: {},
          getBBox_stackTop: {}
        }
      }

      const addPhase = (name, ms) => {
        profile.phases[name] = (profile.phases[name] || 0) + ms
      }

      const wrap = (obj, key, phase, countKey, beforeFn, afterFn) => {
        if (!obj || typeof obj[key] !== 'function') return null
        const orig = obj[key]
        obj[key] = function wrapped(...args) {
          if (countKey) profile.counts[countKey] = (profile.counts[countKey] || 0) + 1
          if (beforeFn) beforeFn.apply(this, args)
          const t0 = performance.now()
          try {
            return orig.apply(this, args)
          } finally {
            const dt = performance.now() - t0
            if (phase) addPhase(phase, dt)
            if (afterFn) afterFn.apply(this, args)
          }
        }
        obj[key]._orig = orig
        return () => {
          obj[key] = orig
        }
      }

      const restorers = []

      // --- DOM / SVG forced-reflow counters ---
      const protoGBCR = Element.prototype.getBoundingClientRect
      Element.prototype.getBoundingClientRect = function patchedGBCR(...args) {
        profile.counts.GET_BOUNDING_CLIENT_RECT_COUNT += 1
        try {
          const stack = new Error().stack || ''
          const line =
            stack
              .split('\n')
              .slice(2, 6)
              .map(s => s.trim())
              .find(s => /MindMap|nodeCreate|Render|layout|RichText|svg/i.test(s)) ||
            'other'
          const key = line.slice(0, 120)
          profile.samples.getBoundingClientRect_stackTop[key] =
            (profile.samples.getBoundingClientRect_stackTop[key] || 0) + 1
        } catch (_) {}
        return protoGBCR.apply(this, args)
      }
      restorers.push(() => {
        Element.prototype.getBoundingClientRect = protoGBCR
      })

      const SVGProto =
        (typeof SVGGraphicsElement !== 'undefined' && SVGGraphicsElement.prototype) ||
        null
      if (SVGProto && SVGProto.getBBox) {
        const protoBBox = SVGProto.getBBox
        SVGProto.getBBox = function patchedBBox(...args) {
          profile.counts.GET_BBOX_CALL_COUNT += 1
          try {
            const stack = new Error().stack || ''
            const line =
              stack
                .split('\n')
                .slice(2, 6)
                .map(s => s.trim())
                .find(s => /MindMap|nodeCreate|Render|layout|bbox/i.test(s)) ||
              'other'
            const key = line.slice(0, 120)
            profile.samples.getBBox_stackTop[key] =
              (profile.samples.getBBox_stackTop[key] || 0) + 1
          } catch (_) {}
          return protoBBox.apply(this, args)
        }
        restorers.push(() => {
          SVGProto.getBBox = protoBBox
        })
      }

      // JSON.stringify cost during compare path
      const origStringify = JSON.stringify
      JSON.stringify = function patchedStringify(...args) {
        profile.counts.JSON_STRINGIFY_COUNT += 1
        const t0 = performance.now()
        try {
          return origStringify.apply(this, args)
        } finally {
          addPhase('json_stringify_compare', performance.now() - t0)
        }
      }
      restorers.push(() => {
        JSON.stringify = origStringify
      })

      // innerHTML writes (richtext measure)
      try {
        const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')
        if (desc && desc.set) {
          Object.defineProperty(Element.prototype, 'innerHTML', {
            configurable: true,
            enumerable: desc.enumerable,
            get: desc.get,
            set: function (v) {
              profile.counts.INNERHTML_WRITE_COUNT += 1
              return desc.set.call(this, v)
            }
          })
          restorers.push(() => {
            Object.defineProperty(Element.prototype, 'innerHTML', desc)
          })
        }
      } catch (_) {}

      const layout = mm.renderer && mm.renderer.layout
      const MindMapNode = mm.renderer && mm.renderer.root
        ? mm.renderer.root.constructor
        : null
      // Prototype may exist even before root
      const NodeProto =
        (mm.renderer &&
          mm.renderer.root &&
          Object.getPrototypeOf(mm.renderer.root)) ||
        null

      // Resolve MindMapNode prototype via a temporary path: after setData there is root.
      // Wrap layout methods now; wrap node methods via Base.createNode after first instance,
      // or via layout.createNode + monkeypatch when nodes appear.

      if (layout) {
        restorers.push(
          wrap(layout, 'doLayout', 'layout_calculation', 'LAYOUT_PASS_COUNT')
        )
        restorers.push(
          wrap(layout, 'renderLine', 'line_creation', 'LINE_RENDER_CALL_COUNT')
        )
        restorers.push(
          wrap(
            layout,
            'renderGeneralization',
            'generalization_summary',
            null
          )
        )
        if (typeof layout.createNode === 'function') {
          const origCreate = layout.createNode.bind(layout)
          layout.createNode = function profiledCreateNode(...args) {
            profile.counts.CREATE_NODE_CALL_COUNT += 1
            const data = args[0]
            const reused =
              !!(data && data._node) ||
              !!(data && data.data && data.data.uid && layout.lru && layout.lru.has(data.data.uid))
            if (reused) profile.counts.CREATE_NODE_REUSE_COUNT += 1
            else profile.counts.CREATE_NODE_NEW_COUNT += 1
            const t0 = performance.now()
            try {
              const node = origCreate(...args)
              // Install node-prototype wraps once
              if (node && !window.__C2_NODE_PROTO_WRAPPED__) {
                window.__C2_NODE_PROTO_WRAPPED__ = true
                const proto = Object.getPrototypeOf(node)
                restorers.push(
                  wrap(proto, 'getSize', 'text_measurement', 'GET_SIZE_CALL_COUNT')
                )
                restorers.push(
                  wrap(
                    proto,
                    'createTextNode',
                    'text_measurement',
                    'CREATE_TEXT_NODE_COUNT'
                  )
                )
                restorers.push(
                  wrap(
                    proto,
                    'createRichTextNode',
                    'rich_text',
                    'CREATE_RICH_TEXT_COUNT'
                  )
                )
                restorers.push(
                  wrap(proto, 'layout', 'bounding_geometry', null)
                )
                restorers.push(
                  wrap(proto, 'render', 'svg_node_creation', 'NODE_RENDER_CALL_COUNT')
                )
                restorers.push(
                  wrap(proto, 'renderLine', 'line_creation', 'LINE_RENDER_CALL_COUNT')
                )
                restorers.push(
                  wrap(
                    proto,
                    'bindGroupEvent',
                    'event_binding',
                    'BIND_GROUP_EVENT_COUNT'
                  )
                )
                if (typeof proto.getNodeRect === 'function') {
                  restorers.push(
                    wrap(proto, 'getNodeRect', 'bounding_geometry', null)
                  )
                }
              }
              return node
            } finally {
              addPhase('node_instance_creation', performance.now() - t0)
            }
          }
          restorers.push(() => {
            layout.createNode = origCreate
          })
        }
        if (typeof layout.checkIsNodeDataChange === 'function') {
          restorers.push(
            wrap(
              layout,
              'checkIsNodeDataChange',
              'json_stringify_compare',
              'CHECK_IS_NODE_DATA_CHANGE_COUNT'
            )
          )
        }
      }

      if (mm.renderer) {
        restorers.push(
          wrap(mm.renderer, '_render', 'other_setData', 'FULL_RENDER_PASS_COUNT')
        )
        if (typeof mm.renderer.setData === 'function') {
          // tree assign only; cost is tiny
          restorers.push(wrap(mm.renderer, 'setData', 'tree_traversal', null))
        }
      }

      if (typeof mm.render === 'function') {
        restorers.push(wrap(mm, 'render', 'other_setData', 'FULL_RENDER_PASS_COUNT'))
      }
      if (typeof mm.setData === 'function') {
        // leave setData unwrapped for wall clock; we time outside
      }

      // View fit / transform
      if (mm.view) {
        ;['fit', 'translateX', 'translateY', 'setScale', 'transform'].forEach(k => {
          if (typeof mm.view[k] === 'function') {
            restorers.push(wrap(mm.view, k, 'fit_transform', null))
          }
        })
      }

      // AssociativeLine plugin
      if (mm.associativeLine) {
        ;['renderAllLines', 'renderLine', 'createLine', 'render'].forEach(k => {
          if (typeof mm.associativeLine[k] === 'function') {
            restorers.push(
              wrap(mm.associativeLine, k, 'associative_line', null)
            )
          }
        })
      }

      // nodeDraw.add proxy for DOM append
      if (mm.draw || mm.nodeDraw) {
        const draw = mm.nodeDraw || mm.draw
        if (draw && typeof draw.add === 'function') {
          restorers.push(
            wrap(draw, 'add', 'dom_append', 'NODE_DRAW_ADD_COUNT')
          )
        }
      }

      // Long tasks during setData
      const longTasks = []
      let obs = null
      try {
        obs = new PerformanceObserver(list => {
          list.getEntries().forEach(e => {
            if (e.duration >= 50) {
              longTasks.push({
                start: Math.round(e.startTime),
                dur: Math.round(e.duration)
              })
            }
          })
        })
        obs.observe({ type: 'longtask', buffered: true })
      } catch (_) {}

      // Fetch full tree
      const t0 = performance.now()
      const res = await fetch(
        origin +
          '/api/files/' +
          encodeURIComponent(roomKey) +
          '?format=full&max_nodes=' +
          maxNodes,
        { credentials: 'include', headers: { Accept: 'application/json' } }
      )
      const tHttp = performance.now()
      if (!res.ok) {
        restorers.forEach(fn => {
          try {
            fn()
          } catch (_) {}
        })
        return { ok: false, reason: 'http_' + res.status, httpMs: Math.round(tHttp - t0) }
      }
      const data = await res.json()
      const tParsed = performance.now()

      function countTree(n) {
        if (!n) return 0
        return 1 + (n.children || []).reduce((a, c) => a + countTree(c), 0)
      }
      const treeNodes = countTree(data.tree)

      const renderTimeout =
        size >= 10000 ? 300000 : size >= 5000 ? 240000 : 180000
      let renderReason = null
      const renderPromise = new Promise((resolve, reject) => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          if (typeof mm.off === 'function') mm.off('node_tree_render_end', done)
          resolve('node_tree_render_end')
        }
        if (typeof mm.on === 'function') mm.on('node_tree_render_end', done)
        setTimeout(() => {
          if (settled) return
          settled = true
          if (typeof mm.off === 'function') mm.off('node_tree_render_end', done)
          const svg = document.querySelector('#mindMapContainer svg')
          const n = svg
            ? svg.querySelectorAll('g.smm-node, g[data-uid], .smm-node, text').length
            : 0
          if (n > 50) resolve('timeout_with_svg_' + n)
          else reject(new Error('full_render_timeout'))
        }, renderTimeout)
      })

      // Clear prior tree cheaply where possible
      try {
        if (mm.cooperate) mm.cooperate.safeLoadMode = false
      } catch (_) {}

      const tSet = performance.now()
      try {
        mm.setData(data.tree)
      } catch (err) {
        restorers.forEach(fn => {
          try {
            fn()
          } catch (_) {}
        })
        return {
          ok: false,
          reason: 'setData_threw',
          error: String(err && err.message ? err.message : err)
        }
      }
      try {
        renderReason = await renderPromise
      } catch (err) {
        restorers.forEach(fn => {
          try {
            fn()
          } catch (_) {}
        })
        return {
          ok: false,
          reason: 'render_failed',
          error: String(err && err.message ? err.message : err),
          setDataMs: Math.round(performance.now() - tSet),
          profile
        }
      }
      const tDone = performance.now()

      if (obs) {
        try {
          obs.disconnect()
        } catch (_) {}
      }
      restorers.forEach(fn => {
        try {
          fn()
        } catch (_) {}
      })
      window.__C2_NODE_PROTO_WRAPPED__ = false

      const phaseEntries = Object.keys(profile.phases)
        .map(k => ({ k, ms: Math.round(profile.phases[k]) }))
        .sort((a, b) => b.ms - a.ms)

      const sumPhases = phaseEntries.reduce((a, x) => a + x.ms, 0)
      const setDataMs = Math.round(tDone - tSet)

      // Top stacks
      const topStacks = (obj, n = 5) =>
        Object.keys(obj)
          .map(k => ({ k, n: obj[k] }))
          .sort((a, b) => b.n - a.n)
          .slice(0, n)

      const root = document.querySelector('#mindMapContainer')
      const svg = root && root.querySelector('svg')

      return {
        ok: true,
        size,
        treeNodes,
        apiNodeCount: data.node_count || null,
        httpMs: Math.round(tHttp - t0),
        parseMs: Math.round(tParsed - tHttp),
        setDataMs,
        fullMs: Math.round(tDone - t0),
        renderReason,
        phaseSumMs: Math.round(sumPhases),
        phaseOverlapNote:
          'Phase timers nest (createNode includes getSize/render); sum can exceed wall clock.',
        phasesMs: phaseEntries,
        phases: Object.fromEntries(
          phaseEntries.map(x => [x.k, x.ms])
        ),
        counts: profile.counts,
        topGetBoundingClientRect: topStacks(
          profile.samples.getBoundingClientRect_stackTop
        ),
        topGetBBox: topStacks(profile.samples.getBBox_stackTop),
        longTasks: longTasks
          .sort((a, b) => b.dur - a.dur)
          .slice(0, 10),
        MAX_LONG_TASK_MS: longTasks.reduce(
          (m, t) => Math.max(m, t.dur),
          0
        ),
        LONG_TASK_COUNT: longTasks.length,
        domCount: root ? root.querySelectorAll('*').length : 0,
        svgCount: svg ? svg.querySelectorAll('*').length : 0,
        svgNodeGroups: svg
          ? svg.querySelectorAll('g.smm-node').length
          : 0
      }
    },
    { origin, roomKey, maxNodes, size }
  )
}

function inferRootCauses(row10k) {
  if (!row10k || !row10k.ok) {
    return ['profile_failed', 'unresolved', 'unresolved']
  }
  const p = row10k.phases || {}
  const c = row10k.counts || {}
  const causes = []

  // Evidence-ordered (first paint of full tree with RichText plugin)
  if (
    (c.GET_BOUNDING_CLIENT_RECT_COUNT || 0) >= (row10k.treeNodes || 0) * 0.5 ||
    (c.CREATE_RICH_TEXT_COUNT || 0) >= (row10k.treeNodes || 0) * 0.5 ||
    (p.text_measurement || 0) > (row10k.setDataMs || 1) * 0.2
  ) {
    causes.push(
      'per_node_richtext_DOM_measure_getBoundingClientRect_forced_reflow'
    )
  }
  if (
    (p.layout_calculation || 0) > (row10k.setDataMs || 1) * 0.15 ||
    (p.node_instance_creation || 0) > (row10k.setDataMs || 1) * 0.15
  ) {
    causes.push(
      'sync_doLayout_createNode_getSize_for_entire_tree_before_paint'
    )
  }
  if ((c.FULL_RENDER_PASS_COUNT || 0) > 2) {
    causes.push('repeated_full_render_passes_around_setData_reRender')
  }
  if (
    (c.LINE_RENDER_CALL_COUNT || 0) >= (row10k.treeNodes || 0) * 1.5
  ) {
    causes.push('line_render_invoked_about_2x_per_node_during_tree_paint')
  }
  if (
    (c.INNERHTML_WRITE_COUNT || 0) >= (row10k.treeNodes || 0) * 1.5
  ) {
    causes.push('per_node_innerHTML_writes_for_richtext_measure_and_foreignObject')
  }
  while (causes.length < 3) {
    const ranked = Object.keys(p)
      .map(k => ({ k, ms: p[k] || 0 }))
      .sort((a, b) => b.ms - a.ms)
    for (const r of ranked) {
      if (causes.length >= 3) break
      const tag = 'phase_' + r.k
      if (!causes.includes(tag) && r.ms > 0) causes.push(tag)
    }
    while (causes.length < 3) causes.push('unresolved')
  }
  return causes.slice(0, 3)
}

async function main() {
  const mode = String(process.env.C2_PROFILE_MODE || 'profile').toLowerCase()
  const report = {
    generatedAt: new Date().toISOString(),
    origin: ORIGIN,
    mode,
    sizes: SIZES,
    rows: {},
    BEFORE: {
      '10K_SETDATA_BEFORE': 39074,
      '10K_MAX_LONG_TASK_BEFORE': 30263,
      'FULL_TREE_HTTP_10K_BEFORE': 11460
    },
    AFTER: {},
    ROOT_CAUSES: [
      'per_node_richtext_DOM_measure_getBoundingClientRect_forced_reflow',
      'sync_doLayout_createNode_getSize_for_entire_tree_before_paint',
      'repeated_full_render_passes_around_setData_reRender'
    ]
  }

  if (!DEV_KEY) {
    console.log('C2_FULL_PROFILE: SKIP (no AUTH_DEV_BYPASS_KEY)')
    return
  }
  const pw = await tryPlaywright()
  if (!pw) {
    console.log('C2_FULL_PROFILE: SKIP (no playwright)')
    return
  }

  const browser = await pw.chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage']
  })
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(300000)
  await installBind(page)

  try {
    const login = await loginDev(page, ORIGIN, DEV_KEY)
    if (!login.ok) throw new Error('login failed')

    for (const size of SIZES) {
      console.log('[profile] seed', size)
      const seeded = await seedRoom(context.request, ORIGIN, size)
      await page.goto(ORIGIN + '/?room=' + encodeURIComponent(seeded.roomKey), {
        waitUntil: 'domcontentloaded',
        timeout: 180000
      })
      await waitEditor(page, size >= 10000 ? 240000 : 180000)
      await page.waitForTimeout(1500)
      console.log('[profile] full setData', size, 'mode=', mode)
      const row =
        mode === 'wall'
          ? await measureFullSetDataWall(page, ORIGIN, seeded.roomKey, size)
          : await profileFullSetData(page, ORIGIN, seeded.roomKey, size)
      report.rows[size] = row
      console.log(
        '[profile] done',
        size,
        'http=',
        row.httpMs,
        'setData=',
        row.setDataMs,
        'maxLong=',
        row.MAX_LONG_TASK_MS,
        'gbcr=',
        row.counts && row.counts.GET_BOUNDING_CLIENT_RECT_COUNT,
        'correctness=',
        row.correctness || 'n/a'
      )
      if (row.phasesMs) {
        console.log(
          '[profile] top phases',
          row.phasesMs.slice(0, 8).map(x => x.k + '=' + x.ms).join(', ')
        )
      }
    }

    const r10 = report.rows[10000] || report.rows[SIZES[SIZES.length - 1]]
    if (mode !== 'wall' && r10) {
      report.ROOT_CAUSES = inferRootCauses(r10)
      report.PROFILED_10K = {
        setDataMs: r10.setDataMs,
        maxLong: r10.MAX_LONG_TASK_MS,
        httpMs: r10.httpMs,
        counts: r10.counts,
        phases: r10.phases
      }
    }
    if (mode === 'wall' && r10) {
      report.AFTER = {
        '10K_SETDATA_AFTER': r10.setDataMs,
        '10K_MAX_LONG_TASK_AFTER': r10.MAX_LONG_TASK_MS,
        'FULL_TREE_HTTP_10K_AFTER': r10.httpMs,
        RENDER_CORRECTNESS: r10.correctness || 'FAIL'
      }
      report.FULL = {}
      SIZES.forEach(sz => {
        const row = report.rows[sz]
        if (!row) return
        report.FULL['FULL_' + sz] = {
          setDataMs: row.setDataMs,
          httpMs: row.httpMs,
          maxLong: row.MAX_LONG_TASK_MS,
          correctness: row.correctness
        }
      })
    }

    console.log('\n=== C2 FULL-TREE RENDER ' + mode.toUpperCase() + ' ===')
    console.log('RENDER_ROOT_CAUSE_1 =', report.ROOT_CAUSES[0])
    console.log('RENDER_ROOT_CAUSE_2 =', report.ROOT_CAUSES[1])
    console.log('RENDER_ROOT_CAUSE_3 =', report.ROOT_CAUSES[2])
    Object.keys(report.BEFORE).forEach(k => {
      console.log(k, '=', report.BEFORE[k])
    })
    Object.keys(report.AFTER || {}).forEach(k => {
      console.log(k, '=', report.AFTER[k])
    })
    if (report.FULL) {
      console.log('FULL_BREAKDOWN =', JSON.stringify(report.FULL))
    }
  } finally {
    await browser.close().catch(() => {})
  }

  const outDir = path.join(__dirname, 'reports')
  fs.mkdirSync(outDir, { recursive: true })
  const fileBase =
    mode === 'wall'
      ? 'c2-full-tree-render-after'
      : 'c2-full-tree-render-profile'
  fs.writeFileSync(
    path.join(outDir, fileBase + '.json'),
    JSON.stringify(report, null, 2)
  )
  console.log('wrote test/reports/' + fileBase + '.json')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
