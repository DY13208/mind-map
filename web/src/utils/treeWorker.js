// This function is self-contained: the same implementation runs in a Worker or
// cooperatively on the main thread when CSP/browser policy disallows Workers.
export function createTreeRuntime() {
  const sessions = new Map()
  const released = new Set()
  const preparing = new Set()
  const clock = () =>
    typeof performance === 'undefined' ? Date.now() : performance.now()
  const pause = () => new Promise(resolve => setTimeout(resolve, 0))
  async function each(items, visit) {
    let start = clock()
    for (let i = 0; i < items.length; i++) {
      visit(items[i], i)
      if (clock() - start >= 8) {
        await pause()
        start = clock()
      }
    }
  }

  // Incremental JSON grammar. Native JSON.parse is restricted to scalar tokens;
  // object/array construction yields, including for a single very long string.
  async function parse(text, valid = () => true) {
    let i = 0,
      result,
      haveRoot = false,
      start = clock()
    const stack = []
    const check = async () => {
      if (!valid()) throw new Error('Cancelled')
      if (clock() - start >= 8) {
        await pause()
        start = clock()
      }
    }
    const put = value => {
      if (!stack.length) {
        if (haveRoot) throw new SyntaxError('Unexpected JSON value')
        result = value
        haveRoot = true
        return
      }
      const frame = stack[stack.length - 1]
      if (frame.array && (frame.state === 'value' || frame.state === 'first'))
        frame.value.push(value)
      else if (!frame.array && frame.state === 'value')
        Object.defineProperty(frame.value, frame.key, {
          value,
          writable: true,
          configurable: true,
          enumerable: true
        })
      else throw new SyntaxError('Unexpected JSON value')
      frame.state = 'comma'
    }
    while (i < text.length) {
      if ((i & 1023) === 0) await check()
      const char = text[i]
      if (/\s/.test(char)) {
        if (!/[\x20\t\r\n]/.test(char))
          throw new SyntaxError('Invalid whitespace')
        i++
        continue
      }
      const frame = stack[stack.length - 1]
      if (char === '}' || char === ']') {
        if (
          !frame ||
          frame.array !== (char === ']') ||
          !['first', 'comma'].includes(frame.state)
        )
          throw new SyntaxError('Unexpected JSON close')
        stack.pop()
        i++
        continue
      }
      if (char === ',') {
        if (!frame || frame.state !== 'comma')
          throw new SyntaxError('Unexpected comma')
        frame.state = frame.array ? 'value' : 'key'
        i++
        continue
      }
      if (char === ':') {
        if (!frame || frame.state !== 'colon')
          throw new SyntaxError('Unexpected colon')
        frame.state = 'value'
        i++
        continue
      }
      if (char === '{' || char === '[') {
        const value = char === '[' ? [] : {}
        put(value)
        stack.push({ value, array: char === '[', state: 'first' })
        i++
        continue
      }
      const begin = i
      if (char === '"') {
        i++
        let escaped = false,
          closed = false
        while (i < text.length) {
          const c = text[i++]
          if (c === '"' && !escaped) {
            closed = true
            break
          }
          escaped = !escaped && c === '\\'
          if ((i & 1023) === 0) await check()
        }
        if (!closed) throw new SyntaxError('Unterminated string')
      } else {
        while (i < text.length && !/[\s,\]}:]/.test(text[i])) {
          i++
          if ((i & 1023) === 0) await check()
        }
        if (i === begin) throw new SyntaxError('Invalid JSON token')
      }
      const value = JSON.parse(text.slice(begin, i))
      if (frame && !frame.array && ['first', 'key'].includes(frame.state)) {
        if (typeof value !== 'string')
          throw new SyntaxError('Invalid object key')
        frame.key = value
        frame.state = 'colon'
      } else put(value)
    }
    if (!haveRoot || stack.length) throw new SyntaxError('Incomplete JSON')
    return result
  }

  async function prepare(graph, sessionId) {
    const index = new Map(),
      order = [],
      seen = new Set()
    const nested = graph && graph.data && Array.isArray(graph.children)
    const keys = nested ? [] : Object.keys(graph || {})
    const rootKey = keys.find(key => graph[key] && graph[key].isRoot) || keys[0]
    const root = nested ? graph : graph && graph[rootKey]
    const queue = root
      ? [{ source: root, uid: nested ? null : rootKey, parent: null }]
      : []
    await each(queue, item => {
      if (released.has(sessionId)) throw new Error('Cancelled')
      const source = item.source
      if (!source || seen.has(source)) return
      seen.add(source)
      const uid = String(
        item.uid ||
          (source.data && source.data.uid) ||
          source.uid ||
          'history-' + order.length
      )
      if (index.has(uid)) return
      const row = {
        uid,
        parent: item.parent,
        data: { ...(source.data || {}), uid },
        children: [],
        descendants: 0
      }
      index.set(uid, row)
      order.push(row)
      if (item.parent && index.has(item.parent))
        index.get(item.parent).children.push(uid)
      const children = (source.children || []).concat(
        (source.data && source.data._overflowChildren) || []
      )
      for (const child of children)
        queue.push({
          source: typeof child === 'string' ? graph[child] : child,
          uid: typeof child === 'string' ? child : null,
          parent: uid
        })
      delete row.data._overflowChildren
    })
    if (!order.length) {
      const row = {
        uid: 'root',
        parent: null,
        data: { uid: 'root', text: '未命名' },
        children: [],
        descendants: 0
      }
      index.set(row.uid, row)
      order.push(row)
    }
    await each(order.slice().reverse(), row => {
      if (row.parent) index.get(row.parent).descendants += row.descendants + 1
    })
    const session = { index, root: order[0].uid, count: order.length }
    if (released.has(sessionId)) {
      released.delete(sessionId)
      throw new Error('Cancelled')
    }
    sessions.set(sessionId, session)
    const tree = stub(session, session.root)
    tree.data.expand = true
    // Small maps retain saved expansion, with the same hard initial budget.
    let remaining = 279
    const display = [{ target: tree, uid: session.root, depth: 0 }]
    await each(display, item => {
      const row = index.get(item.uid)
      if (
        !remaining ||
        (session.count >= 500 && item.depth > 0) ||
        item.target.data.expand === false
      )
        return
      const children = row.children.slice(0, Math.min(48, remaining))
      remaining -= children.length
      item.target.children = children.map((uid, index) => {
        const node = stub(session, uid)
        node.data._historyIndex = index
        return node
      })
      item.target.data.hasMore = children.length < row.children.length
      item.target.children.forEach(child =>
        display.push({
          target: child,
          uid: child.data.uid,
          depth: item.depth + 1
        })
      )
    })
    return { tree, nodeCount: session.count, sessionId }
  }
  function stub(session, uid) {
    const row = session.index.get(uid)
    return {
      data: {
        ...row.data,
        expand: session.count >= 500 ? false : row.data.expand !== false,
        childCount: row.children.length,
        descendantCount: row.descendants,
        hasMore: row.children.length > 0
      },
      children: []
    }
  }
  return async function execute(action, payload) {
    if (action === 'parse') return parse(payload)
    if (action === 'stringify') return JSON.stringify(payload)
    if (action === 'release') {
      sessions.delete(payload.sessionId)
      if (preparing.has(payload.sessionId)) released.add(payload.sessionId)
      return null
    }
    if (action === 'prepare') {
      preparing.add(payload.sessionId)
      try {
        return await prepare(payload.graph, payload.sessionId)
      } finally {
        preparing.delete(payload.sessionId)
        released.delete(payload.sessionId)
      }
    }
    if (action === 'historyResponse') {
      preparing.add(payload.sessionId)
      try {
        const response = await parse(
          payload.raw,
          () => !released.has(payload.sessionId)
        )
        if (!response.tree) return response
        const projected = await prepare(response.tree, payload.sessionId)
        return {
          ...response,
          tree: projected.tree,
          projection: {
            sessionId: payload.sessionId,
            nodeCount: projected.nodeCount
          }
        }
      } finally {
        preparing.delete(payload.sessionId)
        released.delete(payload.sessionId)
      }
    }
    const session = sessions.get(payload.sessionId)
    if (!session) throw new Error('历史预览已过期，请重新选择版本')
    if (action === 'branch') {
      const row = session.index.get(payload.uid)
      if (!row) throw new Error('节点不存在')
      const offset = Math.max(0, Number(payload.offset) || 0)
      const loaded = payload.loaded ? new Set(payload.loaded) : null
      const targetIndex = payload.targetUid
        ? row.children.indexOf(payload.targetUid)
        : -1
      const start =
        targetIndex >= 0 ? Math.floor(targetIndex / 48) * 48 : offset
      const selected =
        loaded && targetIndex < 0
          ? row.children.filter(uid => !loaded.has(uid)).slice(0, 48)
          : row.children.slice(start, start + 48)
      return {
        children: selected.map(uid => {
          const node = stub(session, uid)
          node.data._historyIndex = row.children.indexOf(uid)
          return node
        }),
        total: row.children.length
      }
    }
    if (action === 'search') {
      const query = String(payload.query || '').toLocaleLowerCase()
      const hits = []
      await each(Array.from(session.index.values()), row => {
        if (
          query &&
          hits.length < 100 &&
          String(row.data.text || '')
            .toLocaleLowerCase()
            .includes(query)
        ) {
          const path = []
          let current = row
          while (current) {
            path.push(current.uid)
            current = session.index.get(current.parent)
          }
          hits.push({ uid: row.uid, text: row.data.text, path: path.reverse() })
        }
      })
      return hits
    }
    throw new Error('Unknown tree task')
  }
}

let worker,
  workerUrl,
  failed = false,
  serial = 0
const pending = new Map()
const fallback = createTreeRuntime()
function abortError() {
  const error = new Error('Cancelled')
  error.name = 'AbortError'
  return error
}
function getWorker() {
  if (worker || failed || typeof Worker === 'undefined') return worker
  try {
    workerUrl = URL.createObjectURL(
      new Blob(
        [
          `const execute = (${createTreeRuntime.toString()})(); self.onmessage = async ({data}) => { const {taskId, revision, action, payload} = data; try { self.postMessage({taskId, revision, result: await execute(action, payload)}) } catch (error) { self.postMessage({taskId, revision, error: error.message}) } }`
        ],
        { type: 'application/javascript' }
      )
    )
    worker = new Worker(workerUrl)
    worker.onmessage = ({ data }) => {
      const job = pending.get(data.taskId)
      if (!job || job.revision !== data.revision) return
      pending.delete(data.taskId)
      job.cleanup()
      if (data.error) job.reject(new Error(data.error))
      else job.resolve(data.result)
    }
    worker.onerror = () => {
      failed = true
      worker.terminate()
      worker = null
      URL.revokeObjectURL(workerUrl)
      pending.forEach(job => {
        job.cleanup()
        job.reject(new Error('后台预览处理失败，请重新选择版本'))
      })
      pending.clear()
    }
  } catch (error) {
    failed = true
    if (workerUrl) URL.revokeObjectURL(workerUrl)
  }
  return worker
}

export function treeTask(action, payload, { signal, revision = 0 } = {}) {
  if (signal && signal.aborted) return Promise.reject(abortError())
  const target = getWorker()
  if (!target)
    return fallback(action, payload).then(result => {
      if (signal && signal.aborted) throw abortError()
      return result
    })
  return new Promise((resolve, reject) => {
    const taskId = ++serial
    const abort = () => {
      pending.delete(taskId)
      cleanup()
      reject(abortError())
    }
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', abort)
    }
    pending.set(taskId, { resolve, reject, cleanup, revision })
    if (signal) signal.addEventListener('abort', abort, { once: true })
    try {
      target.postMessage({ taskId, revision, action, payload })
    } catch (error) {
      pending.delete(taskId)
      cleanup()
      reject(error)
    }
  })
}
