'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { randomUUID } = require('node:crypto')
const path = require('node:path')

const uid = label => `concurrent-add-${label}-${randomUUID().replace(/-/g, '').slice(0, 12)}`
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function focusNode(client, nodeUid) {
  const { page } = client
  await page.evaluate(uid => new Promise(resolve => {
    const mm = window.__guardMM
    mm.execCommand('GO_TARGET_NODE', uid, resolve)
  }), nodeUid)
  await page.waitForFunction(uid => !!window.__guardMM.renderer.findNodeByUid(uid)?.group?.node?.isConnected, nodeUid)
  const point = await page.evaluate(uid => {
    const el = window.__guardMM.renderer.findNodeByUid(uid).group.node
    const rect = el.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  }, nodeUid)
  await page.mouse.click(point.x, point.y)
  await page.waitForFunction(uid => window.__guardMM.renderer.activeNodeList.some(node => node.getData('uid') === uid), nodeUid)
}

async function goToNode(client, nodeUid) {
  const { page } = client
  await page.evaluate(uid => new Promise(resolve => {
    const mindMap = window.__guardMM
    if (!mindMap) throw new Error('Mind map is not ready')
    mindMap.execCommand('GO_TARGET_NODE', uid, resolve)
  }), nodeUid)
  await page.waitForFunction(uid => {
    const mindMap = window.__guardMM
    const node = mindMap && mindMap.renderer.findNodeByUid(uid)
    return !!(node && node.group && node.group.node && node.group.node.isConnected)
  }, nodeUid, { timeout: 30000 })
}

async function materializeLazyChildren(client, parentUid, childUids) {
  const { page } = client
  const callback = await page.evaluate(async ({ nodeUid, timeoutMs }) => {
    const mindMap = window.__guardMM
    if (!mindMap?.cooperate?.revealUid) throw new Error('Cooperate.revealUid is not available')
    return Promise.race([
      Promise.resolve(mindMap.cooperate.revealUid(nodeUid)).then(
        () => 'revealed',
        error => `reveal-error:${error?.message || error}`
      ),
      new Promise(resolve => setTimeout(() => resolve('reveal-timeout'), timeoutMs))
    ])
  }, { nodeUid: childUids[0], timeoutMs: 12000 })

  const hasChildren = () => page.waitForFunction(({ parentUid, childUids }) => {
    const parent = window.__guardMM.renderer.findNodeByUid(parentUid)
    const rendered = new Set((parent?.nodeData?.children || []).map(child => child?.data?.uid))
    return childUids.every(uid => rendered.has(uid))
  }, { parentUid, childUids }, { timeout: 10000 }).then(() => true, () => false)

  if (!(await hasChildren())) {
    await page.evaluate(async uid => {
      const mindMap = window.__guardMM
      const parent = mindMap?.renderer?.findNodeByUid(uid)
      if (!parent) throw new Error(`Lazy parent ${uid} is not rendered`)
      if (typeof mindMap.renderer.setNodeExpand !== 'function') {
        throw new Error('Renderer.setNodeExpand is not available')
      }
      await Promise.resolve(mindMap.renderer.setNodeExpand(parent, true))
    }, parentUid)
  }
  await page.waitForFunction(({ parentUid, childUids }) => {
    const parent = window.__guardMM.renderer.findNodeByUid(parentUid)
    const rendered = new Set((parent?.nodeData?.children || []).map(child => child?.data?.uid))
    return childUids.every(uid => rendered.has(uid))
  }, { parentUid, childUids }, { timeout: 30000 })
  return { callback, usedRendererExpandFallback: callback !== 'revealed' }
}

async function openEditor(client, nodeUid) {
  const { page } = client
  await page.evaluate(uid => new Promise(resolve => {
    const mindMap = window.__guardMM
    if (!mindMap) throw new Error('Mind map is not ready')
    mindMap.execCommand('GO_TARGET_NODE', uid, resolve)
  }), nodeUid)
  await page.waitForFunction(uid => {
    const mindMap = window.__guardMM
    const node = mindMap && mindMap.renderer.findNodeByUid(uid)
    return !!(node && node.group && node._textData && node._textData.node)
  }, nodeUid, { timeout: 30000 })
  await page.evaluate(async uid => {
    const mindMap = window.__guardMM
    const node = mindMap && mindMap.renderer.findNodeByUid(uid)
    if (!node || !node.group || !node._textData || !node._textData.node) {
      throw new Error(`Node ${uid} did not finish viewport rendering`)
    }
    await mindMap.renderer.textEdit.show({ node, forceEdit: true })
  }, nodeUid)
  return waitEditor(client, nodeUid)
}

async function editorState(page) {
  return page.evaluate(() => {
    const mm = window.__guardMM
    const rich = mm.richText
    const editor = rich && rich.showTextEdit ? rich : mm.renderer.textEdit
    const node = editor.node || editor.currentNode
    const session = editor.editSessionId && mm.cooperate.getEditSession(editor.editSessionId)
    return {
      open: !!editor.showTextEdit,
      richText: editor === rich,
      uid: node && node.getData('uid'),
      selector: editor === rich
        ? '.smm-richtext-node-edit-wrap .ql-editor[contenteditable="true"]'
        : '.smm-node-edit-wrap[contenteditable="true"]',
      session: session && {
        id: session.id,
        uid: session.uid,
        state: session.state,
        fields: session.fields,
        baseVersions: session.baseVersions,
        baseValues: session.baseValues,
        draft: session.draft,
        conflicts: session.conflicts,
        conflictCode: session.conflictCode,
        latestSnapshot: session.latestSnapshot
      }
    }
  })
}

async function waitEditor(client, expectedUid) {
  const { page } = client
  await page.waitForFunction(uid => {
    const mm = window.__guardMM
    const editor = mm.richText && mm.richText.showTextEdit ? mm.richText : mm.renderer.textEdit
    const node = editor.node || editor.currentNode
    return editor.showTextEdit && node && node.getData('uid') === uid && editor.editSessionId
  }, expectedUid, { timeout: 30000 })
  return editorState(page)
}

async function addChild(client, parentUid) {
  await focusNode(client, parentUid)
  await client.page.keyboard.press('Tab')
  const created = await client.page.waitForFunction(() => {
    const mm = window.__guardMM
    const editor = mm.richText && mm.richText.showTextEdit ? mm.richText : mm.renderer.textEdit
    const node = editor.node || editor.currentNode
    return editor.showTextEdit && node && editor.editSessionId
      ? { uid: node.getData('uid'), richText: editor === mm.richText }
      : null
  }, null, { timeout: 30000 })
  const info = await created.jsonValue()
  return { ...info, editor: await waitEditor(client, info.uid) }
}

async function fillAndSave(client, editor, text) {
  const { page } = client
  await page.locator(editor.selector).waitFor({ state: 'visible' })
  await page.locator(editor.selector).fill(text)
  const input = await editorState(page)
  const result = await saveEditor(page)
  return { input, result, after: await editorState(page) }
}

async function saveEditor(page) {
  return page.evaluate(() => Promise.race([
    Promise.resolve(window.__guardMM.renderer.textEdit.hideEditTextBox()),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Editor save stalled for 15 seconds')), 15000))
  ]))
}

function instrument(client) {
  return client.page.evaluate(() => {
    const mm = window.__guardMM
    const c = mm.cooperate
    const trace = []
    if (!c.__guardTraceSnapshotWrapped) {
      const originalSnapshot = c.persistTraceSnapshot
      window.__traceSnapshotCalls = 0
      c.persistTraceSnapshot = function (...args) {
        window.__traceSnapshotCalls++
        return originalSnapshot.apply(this, args)
      }
      c.__guardTraceSnapshotWrapped = true
    }
    const currentEditor = () => {
      const editor = mm.richText && mm.richText.showTextEdit ? mm.richText : mm.renderer.textEdit
      const node = editor.node || editor.currentNode
      const session = editor.editSessionId && c.getEditSession(editor.editSessionId)
      return { uid: node && node.getData('uid'), sessionId: session && session.id,
        baseVersions: session && session.baseVersions }
    }
    const originalSubmit = c.submitV2
    c.submitV2 = function (type, payload, ...rest) {
      const entry = { at: Date.now(), phase: 'submit', type, payload, editor: currentEditor() }
      trace.push(entry)
      return Promise.resolve(originalSubmit.call(this, type, payload, ...rest)).then(result => {
        trace.push({ at: Date.now(), phase: 'ack', type, payload, editor: currentEditor(), result: {
          version: result && result.version,
          operationId: result && result.operationId,
          duplicate: result && result.duplicate,
          operation: result && result.operation && {
            type: result.operation.type,
            payload: result.operation.payload,
            serverRevision: result.operation.serverRevision,
            opId: result.operation.opId
          }
        } })
        return result
      }, error => {
        trace.push({ at: Date.now(), phase: 'reject', type, payload, editor: currentEditor(), error: {
          message: error && error.message, code: error && error.code, status: error && error.status
        } })
        throw error
      })
    }
    const originalProjectCanonicalChildOrder = c.projectCanonicalChildOrder
    if (typeof originalProjectCanonicalChildOrder === 'function') {
      const snapshotSiblingProjection = parentUid => {
        const currentData = c.currentData || {}
        const parentEntry = currentData[parentUid]
        const parent = mm.renderer.findNodeByUid(parentUid)
        const rendered = parent?.nodeData?.children || []
        const currentOrder = (parentEntry?.children || []).map(uid => String(uid))
        const renderedOrder = rendered.map(node => String(node?.data?.uid || '')).filter(Boolean)
        const childUids = [...new Set([...currentOrder, ...renderedOrder])]
        return {
          currentDataChildrenOrder: currentOrder,
          parentNodeDataChildrenOrder: renderedOrder,
          childStates: childUids.map(uid => {
            const entry = currentData[uid]
            const node = mm.renderer.findNodeByUid(uid)
            return {
              uid,
              parentUid: entry?.parent_uid ?? entry?.parentUid ?? entry?.parent ?? null,
              currentDataPosition: entry?.position ?? entry?.data?.position ?? null,
              renderedPosition: node?.getData?.('position') ?? node?.nodeData?.data?.position ?? null
            }
          })
        }
      }
      c.projectCanonicalChildOrder = function (parentUid, ...args) {
        const tracked = String(window.__canonicalOrderTraceParentUid || '') === String(parentUid)
        if (tracked) trace.push({ at: Date.now(), phase: 'canonical_child_order_before', parentUid,
          snapshot: snapshotSiblingProjection(parentUid) })
        try {
          const result = originalProjectCanonicalChildOrder.call(this, parentUid, ...args)
          if (tracked) trace.push({ at: Date.now(), phase: 'canonical_child_order_after', parentUid,
            result, snapshot: snapshotSiblingProjection(parentUid) })
          return result
        } catch (error) {
          if (tracked) trace.push({ at: Date.now(), phase: 'canonical_child_order_error', parentUid,
            error: { message: error?.message }, snapshot: snapshotSiblingProjection(parentUid) })
          throw error
        }
      }
    }
    const adapter = c.collabV2Adapter
    const originalAdapterSubmit = adapter && adapter.submitOperation
    if (originalAdapterSubmit) {
      adapter.submitOperation = function (raw, ...rest) {
        const delayed = raw && raw.type === 'node.insert' && Number(window.__delayInsertAckCount) > 0
        let ackUid
        if (delayed) window.__delayInsertAckCount -= 1
        return Promise.resolve(originalAdapterSubmit.call(this, raw, ...rest)).then(async result => {
          if (raw && raw.type === 'node.insert') {
            const operation = result && result.operation
            ackUid = (raw.payload && raw.payload.uid) ||
              (operation && operation.payload && operation.payload.uid) ||
              (operation && operation.payload && operation.payload.data && operation.payload.data.uid)
            trace.push({ at: Date.now(), phase: 'transport_ack', type: raw.type,
              uid: ackUid,
              result: { version: result && result.serverRevision, operationId: result && result.opId,
                operationType: operation && operation.type,
                fieldVersions: operation && operation.payload && operation.payload.data && operation.payload.data.__fv } })
          }
          if (delayed) {
            await new Promise(resolve => setTimeout(resolve, Number(window.__delayInsertAckMs) || 200))
            trace.push({ at: Date.now(), phase: 'transport_ack_released', type: raw.type,
              uid: ackUid })
          }
          return result
        })
      }
    }
    window.__delayInsertAckCount = 0
    window.__delayInsertAckMs = 200
    for (const name of ['edit_session_conflict', 'edit_session_outbox_conflict', 'collab_write_conflict']) {
      mm.on(name, (session, error) => trace.push({ at: Date.now(), phase: 'event', name,
        session: session && { id: session.id, uid: session.uid, state: session.state,
          baseVersions: session.baseVersions, conflicts: session.conflicts,
          latestSnapshot: session.latestSnapshot },
        error: error && { message: error.message, code: error.code, status: error.status } }))
    }
    window.__concurrentAddTrace = trace
    return true
  })
}

async function traceFor(client) {
  return client.page.evaluate(() => window.__concurrentAddTrace || [])
}

async function resetTrace(client) {
  await client.page.evaluate(() => { if (window.__concurrentAddTrace) window.__concurrentAddTrace.length = 0 })
}

async function delayNextInsertAck(client, count = 1, milliseconds = 200) {
  await client.page.evaluate(({ count, milliseconds }) => {
    window.__delayInsertAckCount = count
    window.__delayInsertAckMs = milliseconds
  }, { count, milliseconds })
}

async function reloadClient(client, revision) {
  await client.page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 })
  await client.page.waitForFunction(target => {
    const stack = [document.querySelector('#app')?.__vue__]
    const seen = new Set()
    let mm = null
    while (stack.length) {
      const vm = stack.pop()
      if (!vm || seen.has(vm)) continue
      seen.add(vm)
      if (vm.mindMap?.cooperate?.collabV2Adapter) { mm = vm.mindMap; break }
      stack.push(...(vm.$children || []))
    }
    if (!mm) return false
    window.__guardMM = mm
    return mm.renderer.root && !mm.renderer.isRendering &&
      mm.cooperate.collabV2Adapter.getStatus().phase === 'LIVE' &&
      Number(mm.cooperate.lastAppliedVersion) >= Number(target)
  }, Number(revision), { timeout: 120000 })
  await instrument(client)
}

async function serverNode(query, nodeUid) {
  const result = await query(nodeUid)
  const nodes = result.items || result.nodes || []
  return nodes.find(item => String(item.uid || item.data?.uid) === nodeUid) || null
}

async function currentAuthority(client, nodeUid) {
  return client.page.evaluate(uid => {
    const mm = window.__guardMM
    const authority = mm.cooperate.currentData && mm.cooperate.currentData[uid]
    const node = mm.renderer.findNodeByUid(uid)
    return {
      authority: authority && { text: authority.data && authority.data.text, fv: authority.data && authority.data.__fv },
      rendered: node && { text: node.getData('text'), fv: node.getData('__fv') },
      applied: mm.cooperate.lastAppliedVersion,
      submitted: mm.cooperate.submittedVersion,
      session: (() => {
        const sessions = mm.cooperate.editSessionManager.list().filter(item => item.uid === uid)
        return sessions.map(item => ({ id: item.id, state: item.state, baseVersions: item.baseVersions,
          baseValues: item.baseValues, draft: item.draft, conflicts: item.conflicts,
          latestSnapshot: item.latestSnapshot }))
      })()
    }
  }, nodeUid)
}

async function siblingOrdering(client, parentUid, childUids) {
  return client.page.evaluate(({ parentUid, childUids }) => {
    const mm = window.__guardMM
    const currentData = mm.cooperate.currentData || {}
    const parentEntry = currentData[parentUid]
    const parentNode = mm.renderer.findNodeByUid(parentUid)
    const childUid = child => typeof child === 'string'
      ? child
      : String(child?.uid || child?.data?.uid || '')
    const siblings = childUids.map(uid => {
      const entry = currentData[uid]
      const node = mm.renderer.findNodeByUid(uid)
      return {
        uid,
        parent_uid: entry?.parent_uid ?? entry?.parentUid ?? entry?.parent ?? null,
        position: entry?.position ?? entry?.data?.position ?? null,
        renderedPosition: node?.getData?.('position') ?? node?.nodeData?.data?.position ?? null
      }
    })
    return {
      currentDataSiblings: siblings,
      currentDataChildrenOrder: (parentEntry?.children || []).map(childUid).filter(Boolean),
      parentNodeDataChildrenOrder: (parentNode?.nodeData?.children || []).map(child => child?.data?.uid).filter(Boolean)
    }
  }, { parentUid, childUids })
}

async function waitForOwnInsertAck(client, nodeUid) {
  await client.page.waitForFunction(uid => (window.__concurrentAddTrace || []).some(row =>
    row.phase === 'ack' && row.type === 'node.insert' && JSON.stringify(row).includes(uid)
  ), nodeUid, { timeout: 30000 })
  return (await traceFor(client)).filter(row => row.phase === 'ack' && row.type === 'node.insert' && JSON.stringify(row).includes(nodeUid))
}

module.exports = async function runConcurrentAddRepro({ clients, call, batch, query, serverChildren, state, converge, roomKey, check, OUT, expectSuccess = false, compatMode = false, draftDisplayCheck = false }) {
  assert.ok(clients.length >= 2, 'Concurrent add reproduction needs two browser clients')
  await Promise.all(clients.map(instrument))

  async function createParent(label) {
    let parentUid = uid(label)
    const created = compatMode
      ? await call('add_node', { room_key: roomKey, parent: 'root', text: `并发新增父节点 ${label}` })
      : await batch([{ op: 'add', node: parentUid, parent: 'root', text: `并发新增父节点 ${label}` }])
    assert.equal(created.toolError, false, JSON.stringify(created))
    if (compatMode) {
      parentUid = created.uid || created.result?.uid || created.data?.uid
      assert.ok(parentUid, JSON.stringify(created))
      // Legacy MCP writes have no event bridge; explicitly recover only this
      // fixture before the browser-driven concurrent operation begins.
      await Promise.all(clients.map(({ page }) => page.evaluate(() => window.__guardMM.cooperate.collabV2Adapter.resync?.())))
    }
    await converge(await state())
    return parentUid
  }

  await check('父节点由 A 编辑时 B 新增子节点：记录草稿、会话版本、插入 ACK 和冲突事件', async () => {
    const a = clients[0], b = clients[1]
    const parentUid = await createParent('a-edits')
    await Promise.all([resetTrace(a), resetTrace(b)])
    await focusNode(a, parentUid)
    await a.page.keyboard.press('F2')
    const parentEditor = await waitEditor(a, parentUid)
    const parentDraft = `A 保留的父节点草稿 ${parentUid.slice(-6)}`
    await a.page.locator(parentEditor.selector).fill(parentDraft)
    const before = Number(await state())
    await delayNextInsertAck(b)
    const child = await addChild(b, parentUid)
    const childDraft = `B 新增的子节点 ${child.uid.slice(-6)}`
    await b.page.locator(child.editor.selector).fill(childDraft)
    const insertAcks = await waitForOwnInsertAck(b, child.uid)
    await converge(await state())
    const aAfterRemote = await editorState(a.page)
    const aAuthorityAfterRemote = await currentAuthority(a, parentUid)
    const bNewNode = await currentAuthority(b, child.uid)
    const childServer = await serverNode(query, child.uid)
    const aSave = await fillAndSave(a, { ...parentEditor, ...(await editorState(a.page)) }, parentDraft)
    const bSave = await saveEditor(b.page)
    await converge(await state())
    const parentServer = await serverNode(query, parentUid)
    const aEvents = await traceFor(a), bEvents = await traceFor(b)
    const parentConflicts = aEvents.filter(row => row.phase === 'event' && row.name === 'edit_session_conflict' && row.session?.uid === parentUid)
    const result = {
      roomKey, parentUid, childUid: child.uid, beforeRevision: before, afterRevision: Number(await state()),
      aSessionAtOpen: parentEditor.session,
      aSessionAfterBInsert: aAfterRemote.session,
      aAuthorityAfterBInsert: aAuthorityAfterRemote,
      bChildSessionAtOpen: child.editor.session,
      bChildAuthorityBeforeSave: bNewNode,
      bOwnInsertAck: insertAcks,
      bChildServerAfterInsert: childServer && { text: childServer.data?.text, fv: childServer.data?.__fv },
      aSaveResult: aSave.result,
      bSaveResult: bSave,
      parentServerAfterA: parentServer && { text: parentServer.data?.text, fv: parentServer.data?.__fv },
      aEvents, bEvents
    }
    fs.writeFileSync(path.join(OUT, 'concurrent-add-parent-edit.json'), JSON.stringify(result, null, 2))
    if (expectSuccess) {
      assert.equal(parentConflicts.length, 0, 'The parent edit must not receive a conflict from a sibling insert or its own exact ACK')
      assert.equal(aSave.result, true, 'The parent edit should save after the other client inserts a child')
      assert.ok(String(parentServer?.data?.text || '').includes(parentDraft), 'The parent draft was not saved')
      assert.equal(bSave, true, 'The inserted child text should save with its insertion field version')
    }
    await Promise.all([a.page.screenshot({ path: path.join(OUT, 'concurrent-add-parent-edit-a.png') }),
      b.page.screenshot({ path: path.join(OUT, 'concurrent-add-parent-edit-b.png') })])
    return { parentUid, childUid: child.uid, aHadConflict: result.aEvents.some(row => row.phase === 'event' && row.name === 'edit_session_conflict' && row.session?.uid === parentUid),
      aSaveResult: !!aSave.result, bSaveResult: !!bSave, aSessionBaseVersions: parentEditor.session?.baseVersions,
      childSessionBaseVersions: child.editor.session?.baseVersions, serverChildFieldVersions: result.bChildServerAfterInsert?.fv,
      evidence: 'concurrent-add-parent-edit.json' }
  })

  await check('A/B 近同时在同父节点新增不同 UID：比对创建会话基线、服务端字段版本、自身 ACK 与文字提交', async () => {
    // The previous client intentionally retains its failed child draft. Use a
    // clean third browser for the independent near-simultaneous add scenario.
    const [a, b] = [clients[0], clients[2]]
    const parentUid = await createParent('parallel')
    await Promise.all([resetTrace(a), resetTrace(b)])
    await Promise.all([a, b, clients[1]].map(client => client.page.evaluate(uid => {
      window.__canonicalOrderTraceParentUid = uid
    }, parentUid)))
    const beforeRevision = Number(await state())
    await Promise.all([focusNode(a, parentUid), focusNode(b, parentUid)])
    await Promise.all([delayNextInsertAck(a), delayNextInsertAck(b)])
    const [left, right] = await Promise.all([addChild(a, parentUid), addChild(b, parentUid)])
    const leftText = `A 同父新增 ${left.uid.slice(-6)}`
    const rightText = `B 同父新增 ${right.uid.slice(-6)}`
    const sessionsAtEditorOpen = { a: left.editor, b: right.editor }
    // Type and save immediately after each new editor opens. This preserves
    // the real race between the new-node insert ACK and its first text save.
    const [aSave, bSave] = await Promise.all([
      fillAndSave(a, left.editor, leftText),
      fillAndSave(b, right.editor, rightText)
    ])
    const [leftAck, rightAck] = await Promise.all([
      waitForOwnInsertAck(a, left.uid).catch(() => []),
      waitForOwnInsertAck(b, right.uid).catch(() => [])
    ])
    await converge(await state())
    const afterInsertAcks = {
      aSession: await editorState(a.page), bSession: await editorState(b.page),
      aAuthority: await currentAuthority(a, left.uid), bAuthority: await currentAuthority(b, right.uid),
      aSeesB: await currentAuthority(a, right.uid), bSeesA: await currentAuthority(b, left.uid)
    }
    const [aServer, bServer] = await Promise.all([serverNode(query, left.uid), serverNode(query, right.uid)])
    let [aTrace, bTrace] = await Promise.all([traceFor(a), traceFor(b)])
    const serverSiblingRows = await serverChildren(parentUid)
    const serverSiblingOrder = serverSiblingRows.map(row => String(row.uid))
    const clientsAtConvergence = await Promise.all(clients.map(async client => ({ actor: client.actor,
      ...(await siblingOrdering(client, parentUid, [left.uid, right.uid])) })))
    const preMaterializationEvidence = {
      roomKey, parentUid, childUids: { a: left.uid, b: right.uid },
      server: serverSiblingRows,
      clientsAtConvergence,
      traces: { a: aTrace, b: bTrace }
    }
    fs.writeFileSync(path.join(OUT, 'concurrent-add-sibling-order-before-lazy-materialization.json'),
      JSON.stringify(preMaterializationEvidence, null, 2))
    const initiallyLoadedActors = [a, b].map(client => client.actor)
    if (expectSuccess) {
      const expectedPositions = Object.fromEntries(serverSiblingRows.map(row =>
        [String(row.uid), String(row.position || '')]))
      await Promise.all([a, b].map(client => client.page.waitForFunction(({ parentUid, serverOrder, expectedPositions }) => {
        const mm = window.__guardMM
        const view = mm.renderer
        const parent = view.findNodeByUid(parentUid)
        const children = parent?.nodeData?.children || []
        const renderedOrder = children.map(child => String(child?.data?.uid || '')).filter(Boolean)
        if (JSON.stringify(renderedOrder) !== JSON.stringify(serverOrder)) return false
        const positionsMatch = serverOrder.every(uid => {
          const node = view.findNodeByUid(uid)
          const position = node?.getData?.('position') ?? node?.nodeData?.data?.position
          return position != null && String(position) === expectedPositions[uid]
        })
        const schedulerPending = view._remoteRenderScheduler && view._remoteRenderScheduler.isPending()
        const orderPending = mm.cooperate._pendingChildOrderParents &&
          mm.cooperate._pendingChildOrderParents.has(parentUid)
        return positionsMatch && !orderPending && !view.isRendering && !view.renderTimer &&
          !view.hasWaitRendering && !view._remoteRenderPending && !schedulerPending
      }, { parentUid, serverOrder: serverSiblingOrder, expectedPositions }, { timeout: 30000 })))
      const settledTraces = await Promise.all([traceFor(a), traceFor(b)])
      aTrace = settledTraces[0]
      bTrace = settledTraces[1]
    }
    const clientSiblingStatesBeforeMaterialization = await Promise.all(clients.map(async client => ({ actor: client.actor,
      ...(await siblingOrdering(client, parentUid, [left.uid, right.uid])) })))
    preMaterializationEvidence.clientsAfterScheduledProjection = clientSiblingStatesBeforeMaterialization
    preMaterializationEvidence.traces = { a: aTrace, b: bTrace }
    fs.writeFileSync(path.join(OUT, 'concurrent-add-sibling-order-before-lazy-materialization.json'),
      JSON.stringify(preMaterializationEvidence, null, 2))
    if (expectSuccess) {
      for (const view of clientSiblingStatesBeforeMaterialization.filter(view => initiallyLoadedActors.includes(view.actor))) {
        const positions = new Map(view.currentDataSiblings.map(row => [row.uid, row.position == null ? null : String(row.position)]))
        const serverPositions = new Map(serverSiblingRows.map(row => [String(row.uid), String(row.position || '')]))
        for (const childUid of serverSiblingOrder) {
          assert.equal(positions.get(childUid), serverPositions.get(childUid),
            `Loaded client ${view.actor} currentData position diverged before loading the third client`)
        }
        assert.deepEqual(view.currentDataChildrenOrder, serverSiblingOrder,
          `Loaded client ${view.actor} currentData order diverged before loading the third client`)
        assert.deepEqual(view.parentNodeDataChildrenOrder, serverSiblingOrder,
          `Loaded client ${view.actor} canvas sibling order diverged before loading the third client`)
      }
    }
    const lazyClient = clients[1]
    const lazyParentAlreadyMaterialized = await lazyClient.page.evaluate(parentUid => {
      const parent = window.__guardMM.renderer.findNodeByUid(parentUid)
      return !!(parent && Array.isArray(parent.nodeData?.children) && parent.nodeData.children.length)
    }, parentUid)
    let lazyClientMaterialization = { actor: lazyClient.actor, wasMaterializedBeforeNavigation: lazyParentAlreadyMaterialized,
      action: lazyParentAlreadyMaterialized ? 'already-materialized' : null }
    if (!lazyParentAlreadyMaterialized) {
      // This browser did not expand the parent during the race. Use the
      // collaboration reveal path, bounded by a timeout, and only fall back to
      // the renderer's real expansion method for this third browser.
      const materialized = await materializeLazyChildren(lazyClient, parentUid, [left.uid, right.uid])
      lazyClientMaterialization = { ...lazyClientMaterialization, ...materialized,
        action: materialized.usedRendererExpandFallback ? 'renderer.setNodeExpand' : 'cooperate.revealUid',
        navigatedToUid: left.uid }
    }
    const clientSiblingStates = await Promise.all(clients.map(async client => ({ actor: client.actor,
      ...(await siblingOrdering(client, parentUid, [left.uid, right.uid])) })))
    const aConflicts = aTrace.filter(row => row.phase === 'event' && row.name === 'edit_session_conflict' && row.session?.uid === left.uid)
    const bConflicts = bTrace.filter(row => row.phase === 'event' && row.name === 'edit_session_conflict' && row.session?.uid === right.uid)
    const aOutboxConflicts = aTrace.filter(row => row.phase === 'event' && row.name === 'edit_session_outbox_conflict' && row.session?.uid === left.uid)
    const bOutboxConflicts = bTrace.filter(row => row.phase === 'event' && row.name === 'edit_session_outbox_conflict' && row.session?.uid === right.uid)
    const allClientViews = await Promise.all(clients.map(async client => ({ actor: client.actor,
      a: await currentAuthority(client, left.uid), b: await currentAuthority(client, right.uid) })))
    const result = {
      roomKey, parentUid, childUids: { a: left.uid, b: right.uid }, beforeRevision,
      afterRevision: Number(await state()),
      sessionsAtEditorOpen,
      saves: { a: aSave, b: bSave },
      afterInsertAcks,
      ownInsertAcks: { a: leftAck, b: rightAck },
      serverChildren: {
        a: aServer && { text: aServer.data?.text, fv: aServer.data?.__fv },
        b: bServer && { text: bServer.data?.text, fv: bServer.data?.__fv }
      },
      siblingOrder: { server: serverSiblingRows, beforeLazyMaterialization: clientSiblingStatesBeforeMaterialization,
        lazyClientMaterialization, clients: clientSiblingStates },
      traces: { a: aTrace, b: bTrace }, allClientViews
    }
    fs.writeFileSync(path.join(OUT, 'concurrent-add-same-parent.json'), JSON.stringify(result, null, 2))
    if (expectSuccess) {
      assert.ok(left.uid && right.uid && left.uid !== right.uid, 'Both clients must insert distinct child UIDs')
      assert.equal(aSave.result, true, 'A child text save should wait for insert ACK and succeed')
      assert.equal(bSave.result, true, 'B child text save should wait for insert ACK and succeed')
      assert.equal(aConflicts.length + bConflicts.length + aOutboxConflicts.length + bOutboxConflicts.length, 0,
        'Self insert/update ACKs must not surface conflict events for the newly created children')
      for (const [name, childUid, acks, trace] of [['A', left.uid, leftAck, aTrace], ['B', right.uid, rightAck, bTrace]]) {
        assert.ok(acks.some(row => row.result?.operation?.type === 'node.inserted' && row.result?.operation?.payload?.uid === childUid),
          `${name} insert ACK must expose its canonical inserted UID`)
        const released = trace.findIndex(row => row.phase === 'transport_ack_released' && row.uid === childUid)
        const firstTextSubmit = trace.findIndex(row => row.phase === 'submit' && row.type === 'node.update' && row.payload?.uid === childUid)
        assert.ok(released >= 0 && firstTextSubmit > released,
          `${name} text update must be submitted only after its delayed insert ACK (release=${released}, update=${firstTextSubmit})`)
      }
      assert.ok(String(aServer?.data?.text || '').includes(leftText), 'A child text was not saved')
      assert.ok(String(bServer?.data?.text || '').includes(rightText), 'B child text was not saved')
      assert.equal(Number(await state()), beforeRevision + 4, 'Two inserts and two text saves should commit four revisions')
      assert.deepEqual(serverSiblingOrder.slice().sort(), [left.uid, right.uid].sort(),
        'The new test parent should contain exactly the two independently inserted children')
      const serverPositions = new Map(serverSiblingRows.map(row => [String(row.uid), String(row.position || '')]))
      for (const view of clientSiblingStates) {
        const clientPositions = new Map(view.currentDataSiblings.map(row => [row.uid, row.position == null ? null : String(row.position)]))
        for (const uid of serverSiblingOrder) {
          assert.equal(clientPositions.get(uid), serverPositions.get(uid),
            `Client ${view.actor} currentData position diverged for ${uid}`)
        }
        assert.deepEqual(view.currentDataChildrenOrder, serverSiblingOrder,
          `Client ${view.actor} currentData sibling UID order diverged from server position/UID order`)
        assert.deepEqual(view.parentNodeDataChildrenOrder, serverSiblingOrder,
          `Client ${view.actor} rendered parent.nodeData.children order diverged from server position/UID order`)
      }
      for (const view of allClientViews) {
        assert.ok(String(view.a.authority?.text || '').includes(leftText), `Client ${view.actor} did not converge on A child`)
        assert.ok(String(view.b.authority?.text || '').includes(rightText), `Client ${view.actor} did not converge on B child`)
      }
    }
    await Promise.all([goToNode(a, left.uid), goToNode(b, right.uid)])
    await Promise.all([a.page.screenshot({ path: path.join(OUT, 'concurrent-add-same-parent-a.png') }),
      b.page.screenshot({ path: path.join(OUT, 'concurrent-add-same-parent-b.png') })])
    return {
      parentUid, childUids: result.childUids,
      insertAckRevisions: { a: leftAck.at(-1)?.result?.version, b: rightAck.at(-1)?.result?.version },
      sessionBaseVersions: { a: left.editor.session?.baseVersions, b: right.editor.session?.baseVersions },
      serverFieldVersions: { a: result.serverChildren.a?.fv, b: result.serverChildren.b?.fv },
      saveResults: { a: !!aSave.result, b: !!bSave.result },
      conflictEvents: { a: aTrace.filter(row => row.phase === 'event' && row.name.includes('conflict')),
        b: bTrace.filter(row => row.phase === 'event' && row.name.includes('conflict')) },
      textSubmitBeforeInsertAck: {
        a: (() => { const update = aTrace.findIndex(row => row.phase === 'submit' && row.type === 'node.update' && row.payload?.uid === left.uid); const ack = aTrace.findIndex(row => row.phase === 'transport_ack_released' && row.uid === left.uid); return update >= 0 && (ack < 0 || update < ack) })(),
        b: (() => { const update = bTrace.findIndex(row => row.phase === 'submit' && row.type === 'node.update' && row.payload?.uid === right.uid); const ack = bTrace.findIndex(row => row.phase === 'transport_ack_released' && row.uid === right.uid); return update >= 0 && (ack < 0 || update < ack) })()
      },
      evidence: 'concurrent-add-same-parent.json'
    }
  })

  await check('真实同字段竞争仍拒绝旧文本并保留人工草稿' + (compatMode ? '（第三浏览器提交）' : '（MCP 提交）'), async () => {
    const a = clients[0]
    await reloadClient(a, await state())
    const targetUid = await createParent('same-field')
    await resetTrace(a)
    const baseline = await serverNode(query, targetUid)
    assert.ok(baseline, `Missing test node ${targetUid}`)
    const editor = await openEditor(a, targetUid)
    const draft = `浏览器人工草稿 ${targetUid.slice(-6)}`
    await a.page.locator(editor.selector).fill(draft)
    const competitorText = draftDisplayCheck ? `<p>远端同字段竞争 ${targetUid.slice(-6)}</p><p>服务端第二段 &amp; 内容</p>` : `远端同字段竞争 ${targetUid.slice(-6)}`
    const competitor = compatMode ? await clients[2].page.evaluate(async ({ uid, version, text, richText }) => {
      await window.__guardMM.cooperate.submitV2('node.update', { uid,
        patch: { text, ...(richText ? { richText: true } : {}) }, expected: { uid, '__fv.text': version } })
      return { toolError: false }
    }, { uid: targetUid, version: baseline.data.__fv?.text || 0, text: competitorText, richText: draftDisplayCheck }) : await call('update_node', { room_key: roomKey, node: targetUid,
      text: competitorText,
      expected: { uid: targetUid, '__fv.text': baseline.data.__fv?.text || 0 } })
    assert.equal(competitor.toolError, false, JSON.stringify(competitor))
    const competitorRevision = Number(await state())
    await converge(competitorRevision)
    const conflictView = await editorState(a.page)
    const saveResult = await saveEditor(a.page)
    const afterSave = await editorState(a.page)
    const server = await serverNode(query, targetUid)
    const trace = await traceFor(a)
    const conflicts = trace.filter(row => row.phase === 'event' && row.name === 'edit_session_conflict' && row.session?.uid === targetUid)
    assert.equal(saveResult, false, 'A stale same-field editor must remain open and reject save')
    assert.equal(Number(await state()), competitorRevision, 'Rejected stale browser save must not add a revision')
    assert.ok(String(server?.data?.text || '').includes('远端同字段竞争'), 'The winning server text must remain intact')
    assert.ok(String(conflictView.session?.draft?.text || '').includes(draft), 'The browser draft must remain available')
    if (expectSuccess) assert.ok(conflicts.some(row => row.error?.code === 'REPLACE_CONFLICT'), 'Same-field competition must still report REPLACE_CONFLICT')
    const detail = { roomKey, targetUid, baseline: { text: baseline.data.text, fv: baseline.data.__fv },
      competitor, competitorRevision, editorAtConflict: conflictView, saveResult, editorAfterAttempt: afterSave,
      server: server && { text: server.data?.text, fv: server.data?.__fv }, conflicts }
    fs.writeFileSync(path.join(OUT, 'concurrent-add-same-field-control.json'), JSON.stringify(detail, null, 2))
    await a.page.screenshot({ path: path.join(OUT, 'conflict-editor.png') })
    if (draftDisplayCheck) {
      assert.match(conflictView.session.draft.text, /<p>/, 'The original rich-text draft must remain intact')
      await a.page.locator('.conflictDraftInbox > button').click()
      const item = a.page.locator('.conflictDraftItem').filter({ hasText: targetUid }).first()
      await item.waitFor({ state: 'visible' })
      if (!(await item.locator('.conflictDraftPanel').count())) await item.locator('.itemHead button').click()
      const panel = item.locator('.conflictDraftPanel')
      await panel.waitFor({ state: 'visible' })
      await panel.locator('.draftActions > button').first().click()
      const draftDisplay = await panel.locator('.draftSection pre').first().innerText()
      await a.page.waitForFunction(text => [...document.querySelectorAll('.latestSection pre')].some(el => el.textContent.includes(text)), '服务端第二段')
      const latestDisplay = await panel.locator('.latestSection pre').innerText()
      assert.ok(draftDisplay.includes(draft))
      assert.doesNotMatch(draftDisplay, /<\/?p>/)
      await a.page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
        configurable: true, value: { writeText: async text => { window.__copiedConflictDraft = text } }
      }))
      await panel.locator('.draftSectionHead button').click()
      assert.equal(await a.page.evaluate(() => window.__copiedConflictDraft), draftDisplay, 'Copy must match the readable draft without changing the system clipboard')
      assert.ok(latestDisplay.includes('服务端第二段 & 内容'))
      assert.doesNotMatch(latestDisplay, /<\/?p>|&amp;/)
      assert.equal((await serverNode(query, targetUid)).data.text, server.data.text, 'Viewing drafts must not rewrite the server')
      detail.display = { draftDisplay, latestDisplay, originalDraftHtml: conflictView.session.draft.text }
      fs.writeFileSync(path.join(OUT, 'concurrent-add-same-field-control.json'), JSON.stringify(detail, null, 2))
      await a.page.screenshot({ path: path.join(OUT, 'conflict-draft-readable.png') })
    }
    return { targetUid, competitorRevision, rejectedOldSave: saveResult === false, draftPreserved: true,
      conflictCodes: conflicts.map(row => row.error?.code), evidence: 'concurrent-add-same-field-control.json' }
  })
}
