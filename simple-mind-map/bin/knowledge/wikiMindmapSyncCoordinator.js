/**
 * Per-page Wiki→Mindmap sync coordinator (mirrors docmostSyncCoordinator).
 *
 * - single-flight per page_id
 * - coalesce while running (dirty → rerun)
 * - optional short debounce to absorb autosave / writeback storms
 * - never blocks the Wiki save HTTP path (callers only enqueue)
 */
/** @type {Map<string, any>} */
const pages = new Map()

const DEFAULT_DEBOUNCE_MS = 600

function getState(pageId) {
  const key = String(pageId || '')
  if (!key) throw new Error('wikiMindmapSyncCoordinator: pageId required')
  let st = pages.get(key)
  if (!st) {
    st = {
      running: null,
      dirty: false,
      debounceTimer: null,
      waiters: [],
      lastResult: null,
      runs: 0,
      options: {}
    }
    pages.set(key, st)
  }
  return st
}

function clearDebounce(st) {
  if (st.debounceTimer) {
    clearTimeout(st.debounceTimer)
    st.debounceTimer = null
  }
}

function kick(pageId) {
  const st = getState(pageId)
  if (st.running) return st.running

  st.running = (async () => {
    let lastResult = null
    try {
      for (;;) {
        st.dirty = false
        st.runs += 1
        const syncFn = st.options.syncFn
        if (typeof syncFn !== 'function') {
          lastResult = {
            success: false,
            error: 'SYNC_FN_MISSING',
            page_id: pageId,
            skipped: 1
          }
          break
        }
        const started = Date.now()
        try {
          lastResult = await syncFn(pageId, st.options)
        } catch (err) {
          lastResult = {
            success: false,
            error: (err && err.code) || 'WIKI_MINDMAP_SYNC_ERROR',
            message: (err && err.message) || String(err),
            page_id: pageId
          }
          console.error(
            '[WikiMindmapSync] page_id=' +
              pageId +
              ' status=failed error=' +
              lastResult.error +
              ' duration=' +
              (Date.now() - started) +
              'ms'
          )
        }
        st.lastResult = lastResult
        if (!st.dirty) break
        console.log(
          '[WikiMindmapSync] page_id=' +
            pageId +
            ' action=coalesce status=rerun'
        )
      }
    } finally {
      const waiters = st.waiters.splice(0, st.waiters.length)
      st.running = null
      waiters.forEach(w => {
        try {
          w.resolve(lastResult)
        } catch (_) {
          /* ignore */
        }
      })
    }
    return lastResult
  })()

  return st.running
}

/**
 * Enqueue async Wiki→Mindmap sync for a page. Returns immediately after
 * scheduling (unless wait:true).
 *
 * @param {string} pageId
 * @param {{ syncFn?: Function, debounceMs?: number, allowMove?: boolean, allowDelete?: boolean, actorId?: string, wait?: boolean }} opts
 */
function requestSync(pageId, opts = {}) {
  const id = String(pageId || '').trim()
  if (!id) {
    return Promise.resolve({
      success: false,
      error: 'MISSING_PAGE_ID',
      accepted: false
    })
  }
  const st = getState(id)
  st.options = {
    ...st.options,
    ...opts,
    syncFn: opts.syncFn || st.options.syncFn
  }

  const debounceMs =
    opts.debounceMs != null
      ? Number(opts.debounceMs)
      : st.options.debounceMs != null
        ? Number(st.options.debounceMs)
        : DEFAULT_DEBOUNCE_MS

  if (st.running) {
    st.dirty = true
    if (opts.wait) {
      return new Promise((resolve, reject) => {
        st.waiters.push({ resolve, reject })
      })
    }
    return Promise.resolve({
      success: true,
      accepted: true,
      coalesced: true,
      page_id: id
    })
  }

  clearDebounce(st)
  if (debounceMs > 0 && !opts.wait) {
    // Schedule debounce but resolve immediately so Wiki save / Docmost hook
    // never waits on Mindmap sync (Docmost client aborts ~3s).
    st.debounceTimer = setTimeout(() => {
      st.debounceTimer = null
      kick(id)
    }, debounceMs)
    return Promise.resolve({
      success: true,
      accepted: true,
      coalesced: false,
      page_id: id,
      debounced_ms: debounceMs
    })
  }

  const run = kick(id)
  if (opts.wait) return run
  return Promise.resolve({
    success: true,
    accepted: true,
    coalesced: false,
    page_id: id
  })
}

function requestSyncAndWait(pageId, opts = {}) {
  return requestSync(pageId, { ...opts, wait: true, debounceMs: 0 })
}

/** @internal test helper */
function _resetForTests() {
  for (const st of pages.values()) clearDebounce(st)
  pages.clear()
}

module.exports = {
  requestSync,
  requestSyncAndWait,
  DEFAULT_DEBOUNCE_MS,
  _resetForTests
}
