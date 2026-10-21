'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

function uid(label) {
  return `guard-ui-${label}-${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

function nodeFromQuery(result, expectedUid) {
  const nodes = result && (result.items || result.nodes)
  const item = Array.isArray(nodes)
    ? nodes.find(node => String(node.uid || node.data?.uid) === String(expectedUid)) || nodes[0]
    : null
  assert.ok(item, `query_nodes returned no node ${expectedUid}: ${JSON.stringify(result).slice(0, 800)}`)
  return item.data ? item : { ...item, data: item }
}

async function createNode({ batch, query, converge, state, roomKey }, text) {
  const id = uid('interaction')
  const result = await batch([{ op: 'add', node: id, parent: 'root', text }])
  assert.equal(result.toolError, false, `Failed to create interaction node ${id}: ${JSON.stringify(result)}`)
  assert.equal(result.outcome, 'applied', `Interaction node add was not applied: ${JSON.stringify(result)}`)
  const revision = Number(await state())
  await converge(revision)
  return { uid: id, item: nodeFromQuery(await query(id), id), roomKey }
}

async function waitForMap(page, revision) {
  await page.waitForFunction(targetRevision => {
    const root = document.querySelector('#app')
    const stack = [root && root.__vue__]
    const seen = new Set()
    let mindMap = null
    while (stack.length) {
      const vm = stack.pop()
      if (!vm || seen.has(vm)) continue
      seen.add(vm)
      if (vm.mindMap?.cooperate?.collabV2Adapter) {
        mindMap = vm.mindMap
        break
      }
      stack.push(...(vm.$children || []))
    }
    if (!mindMap) return false
    window.__guardMM = mindMap
    const status = mindMap.cooperate.collabV2Adapter.getStatus()
    return (
      status.phase === 'LIVE' &&
      Number(mindMap.cooperate.lastAppliedVersion) >= Number(targetRevision) &&
      !mindMap.renderer.isRendering &&
      status.pendingCount === 0
    )
  }, Number(revision), { timeout: 90000 })
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

  const editorHandle = await page.waitForFunction(() => {
    const mindMap = window.__guardMM
    if (!mindMap) return null
    if (mindMap.richText && mindMap.richText.showTextEdit) {
      const el = mindMap.richText.textEditNode &&
        mindMap.richText.textEditNode.querySelector('.ql-editor[contenteditable="true"]')
      if (el) return { selector: '.smm-richtext-node-edit-wrap .ql-editor[contenteditable="true"]', richText: true }
    }
    const el = mindMap.renderer.textEdit.textEditNode
    if (mindMap.renderer.textEdit.showTextEdit && el) {
      return { selector: '.smm-node-edit-wrap[contenteditable="true"]', richText: false }
    }
    return null
  }, null, { timeout: 15000 })
  return editorHandle.jsonValue()
}

async function editorState(page) {
  return page.evaluate(() => {
    const mindMap = window.__guardMM
    const richText = mindMap && mindMap.richText
    const editor = richText && richText.showTextEdit
      ? richText
      : mindMap && mindMap.renderer.textEdit
    if (!editor) return null
    const dom = richText && richText.showTextEdit
      ? richText.textEditNode && richText.textEditNode.querySelector('.ql-editor')
      : editor.textEditNode
    return {
      open: !!editor.showTextEdit,
      richText: editor === richText,
      nodeText: (() => {
        const node = editor.node || editor.currentNode
        return node && node.getData ? node.getData('text') : null
      })(),
      text: dom ? (dom.innerText || dom.textContent || '') : '',
      html: dom ? dom.innerHTML : '',
      session: editor.editSessionId
        ? mindMap.cooperate.getEditSession(editor.editSessionId)
        : null
    }
  })
}

async function fillEditor(page, editor, text) {
  const locator = page.locator(editor.selector)
  await locator.waitFor({ state: 'visible', timeout: 15000 })
  await locator.fill(text)
  return editorState(page)
}

async function hideEditor(page) {
  return page.evaluate(() => window.__guardMM.renderer.textEdit.hideEditTextBox())
}

async function waitForInboxDraft(page, nodeUid, expectedDraftText) {
  await page.waitForFunction(({ nodeUid, expectedDraftText }) => {
    const stack = [document.querySelector('#app')?.__vue__]
    const seen = new Set()
    while (stack.length) {
      const vm = stack.pop()
      if (!vm || seen.has(vm)) continue
      seen.add(vm)
      if (vm.$options && vm.$options.name === 'ConflictDraftInbox') {
        return !!(vm.drafts && vm.drafts.some(item =>
          item.uid === nodeUid && item.session && item.session.draft &&
          String(item.session.draft.text || '').includes(expectedDraftText)
        ))
      }
      stack.push(...(vm.$children || []))
    }
    return false
  }, { nodeUid, expectedDraftText }, { timeout: 30000 })
}

async function readStoredConflictDrafts(page, nodeUid, roomKey) {
  return page.evaluate(({ nodeUid, roomKey }) => new Promise((resolve, reject) => {
    const request = indexedDB.open('mind-map-local', 1)
    request.onupgradeneeded = () => {
      request.transaction.abort()
      reject(new Error('The application local IndexedDB was not initialized'))
    }
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'))
    request.onsuccess = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('drafts')) {
        db.close()
        reject(new Error('IndexedDB drafts object store is missing'))
        return
      }
      const tx = db.transaction('drafts', 'readonly')
      const cursorRequest = tx.objectStore('drafts').openCursor()
      const found = []
      cursorRequest.onerror = () => {
        db.close()
        reject(cursorRequest.error || new Error('IndexedDB cursor failed'))
      }
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (!cursor) return
        const key = String(cursor.key)
        const value = cursor.value
        if (
          key.startsWith('conflictDraft:v1:') &&
          value &&
          value.uid === nodeUid &&
          value.room === roomKey
        ) {
          found.push({ key, value })
        }
        cursor.continue()
      }
      tx.oncomplete = () => {
        db.close()
        resolve(found)
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error || new Error('IndexedDB read failed'))
      }
    }
  }), { nodeUid, roomKey })
}

module.exports = async function runInteractionChecks({
  clients,
  call,
  query,
  batch,
  state,
  converge,
  roomKey,
  check,
  origin,
  OUT
}) {
  assert.ok(Array.isArray(clients) && clients.length >= 2, 'Browser interaction checks need at least two live clients')
  assert.equal(typeof call, 'function', 'MCP call helper is required')
  assert.equal(typeof query, 'function', 'query_nodes helper is required')
  assert.equal(typeof batch, 'function', 'apply_nodes helper is required')
  assert.equal(typeof converge, 'function', 'browser convergence helper is required')
  assert.equal(typeof check, 'function', 'check evidence helper is required')
  assert.ok(origin && OUT, 'browser origin and evidence directory are required')

  for (const client of clients.slice(0, 2)) await waitForMap(client.page, await state())

  await check('真实富文本 DOM：输入法合成中阻止提交', async () => {
    const fixture = await createNode({ batch, query, converge, state, roomKey }, '输入法初始内容')
    const client = clients[0]
    const { page } = client
    const revisionBefore = Number(await state())
    const editor = await openEditor(client, fixture.uid)
    const partialText = '输入法候选内容'
    await page.locator(editor.selector).dispatchEvent('compositionstart', { data: '', bubbles: true })
    await fillEditor(page, editor, partialText)
    const active = await editorState(page)
    assert.ok(active.session, 'TextEdit entry did not create an edit session')
    assert.equal(active.session.composing, true, 'compositionstart did not reach the edit session')
    assert.ok(active.session.draft.text.includes(partialText), 'DOM input was not retained as a composing draft')
    assert.equal(active.nodeText, '输入法初始内容', 'IME candidate leaked into the rendered node before composition ended')

    const hideResult = await hideEditor(page)
    const revisionDuringComposition = Number(await state())
    const serverDuringComposition = nodeFromQuery(await query(fixture.uid), fixture.uid).data
    const stillOpen = await editorState(page)
    assert.equal(hideResult, false, `Composition hide should be blocked; result=${JSON.stringify(hideResult)}`)
    assert.equal(revisionDuringComposition, revisionBefore, 'Composition attempt created a server revision')
    assert.equal(serverDuringComposition.text, '输入法初始内容', 'Composition candidate reached the server')
    assert.equal(stillOpen.open, true, 'Editor closed while composition was active')

    await page.locator(editor.selector).dispatchEvent('compositionend', { data: partialText, bubbles: true })
    const finalText = '输入法确认后提交'
    await fillEditor(page, editor, finalText)
    const saveResult = await hideEditor(page)
    assert.equal(saveResult, true, `Completed composition did not save: ${JSON.stringify(saveResult)}`)
    const revisionAfter = Number(await state())
    assert.ok(revisionAfter > revisionBefore, 'Final composition save did not create a revision')
    await converge(revisionAfter)
    const saved = nodeFromQuery(await query(fixture.uid), fixture.uid).data
    assert.ok(String(saved.text).includes(finalText), `Final text was not saved: ${JSON.stringify(saved.text)}`)
    const screenshot = path.join(OUT, 'interaction-ime-complete.png')
    await page.screenshot({ animations: 'disabled', path: screenshot, fullPage: false })
    return {
      uid: fixture.uid,
      editorKind: editor.richText ? 'RichText/Quill DOM' : 'TextEdit contenteditable DOM',
      compositionBlocked: hideResult === false,
      revisionDuringComposition,
      revisionAfter,
      savedText: saved.text,
      screenshot
    }
  })

  await check('浏览器草稿与 MCP 同字段并发：远端提交后保留输入、拒绝旧草稿并从真实 IndexedDB 恢复', async () => {
    const fixture = await createNode({ batch, query, converge, state, roomKey }, '协同冲突基线')
    const editingClient = clients[0]
    const editingPage = editingClient.page
    const editingEditor = await openEditor(editingClient, fixture.uid)
    const localDraft = `本地草稿-${fixture.uid.slice(-6)}`
    await fillEditor(editingPage, editingEditor, localDraft)
    const openingState = await editorState(editingPage)
    assert.ok(openingState.session, 'Browser editor did not capture a conflict baseline')

    const remoteText = `MCP 协作者新内容-${fixture.uid.slice(-6)}`
    const openingBaseVersion = Number(openingState.session.baseVersions?.text) || 0
    const remoteSave = await call('update_node', {
      room_key: roomKey,
      node: fixture.uid,
      text: remoteText,
      expected: { uid: fixture.uid, '__fv.text': openingBaseVersion }
    })
    assert.equal(remoteSave.toolError, false, `MCP writer could not save the same-field edit: ${JSON.stringify(remoteSave)}`)
    const remoteRevision = Number(await state())
    await converge(remoteRevision)

    const visibleDraft = await editorState(editingPage)
    assert.equal(visibleDraft.open, true, 'First browser editor closed after remote rendering')
    assert.ok(visibleDraft.text.includes(localDraft), `Remote application replaced the first browser draft: ${JSON.stringify(visibleDraft)}`)
    const beforeRejectedSave = Number(await state())
    const rejectedSave = await hideEditor(editingPage)
    const afterRejectedSave = Number(await state())
    const serverNode = nodeFromQuery(await query(fixture.uid), fixture.uid).data
    const keptDraft = await editorState(editingPage)
    assert.equal(rejectedSave, false, `Stale same-field edit was not held for review: ${JSON.stringify(rejectedSave)}`)
    assert.equal(afterRejectedSave, beforeRejectedSave, 'Rejected stale edit created a revision')
    assert.ok(String(serverNode.text).includes(remoteText), `Remote value was overwritten: ${JSON.stringify(serverNode.text)}`)
    assert.equal(keptDraft.open, true, 'Editor closed after conflict')
    assert.ok(keptDraft.text.includes(localDraft), `Conflict handling lost the local draft: ${JSON.stringify(keptDraft)}`)

    await waitForInboxDraft(editingPage, fixture.uid, localDraft)
    const inbox = editingPage.locator('.conflictDraftInbox > button')
    await inbox.waitFor({ state: 'visible', timeout: 15000 })
    await inbox.click()
    await editingPage.locator('.conflictDraftPanel').waitFor({ state: 'visible', timeout: 15000 })
    const screenshot = path.join(OUT, 'interaction-conflict-before-refresh.png')
    await editingPage.screenshot({ animations: 'disabled', path: screenshot, fullPage: false })

    const beforeRefreshRecords = await readStoredConflictDrafts(editingPage, fixture.uid, roomKey)
    assert.ok(beforeRefreshRecords.length > 0, 'ConflictDraftInbox did not write a record to IndexedDB')
    const stored = beforeRefreshRecords.find(item =>
      String(item.value.session?.draft?.text || '').includes(localDraft)
    )
    assert.ok(stored, `IndexedDB record did not contain the local draft: ${JSON.stringify(beforeRefreshRecords).slice(0, 1000)}`)

    await editingPage.reload({ waitUntil: 'domcontentloaded', timeout: 120000 })
    await waitForMap(editingPage, Number(await state()))
    await waitForInboxDraft(editingPage, fixture.uid, localDraft)
    await editingPage.locator('.conflictDraftInbox > button').waitFor({ state: 'visible', timeout: 15000 })
    const afterRefreshRecords = await readStoredConflictDrafts(editingPage, fixture.uid, roomKey)
    const recovered = afterRefreshRecords.find(item =>
      String(item.value.session?.draft?.text || '').includes(localDraft)
    )
    assert.ok(recovered, 'Conflict draft was not recoverable from IndexedDB after page refresh')
    await editingPage.locator('.conflictDraftInbox > button').click()
    await editingPage.locator('.conflictDraftPanel').waitFor({ state: 'visible', timeout: 15000 })
    const recoveredPanelText = await editingPage.locator('.conflictDraftPanel').innerText()
    assert.ok(recoveredPanelText.includes(localDraft), 'ConflictDraftInbox did not render the recovered local draft')
    const recoveredScreenshot = path.join(OUT, 'interaction-conflict-after-refresh.png')
    await editingPage.screenshot({ animations: 'disabled', path: recoveredScreenshot, fullPage: false })
    return {
      uid: fixture.uid,
      remoteRevision,
      rejectedRevision: afterRejectedSave,
      remoteText: serverNode.text,
      editorDraft: keptDraft.text,
      localDraft,
      indexedDbKey: recovered.key,
      recordsBeforeRefresh: beforeRefreshRecords.length,
      recordsAfterRefresh: afterRefreshRecords.length,
      recoveredInInbox: true,
      screenshots: [screenshot, recoveredScreenshot]
    }
  })

  await check('不同字段并行提交：文本会话与备注写入互不冲突', async () => {
    const fixture = await createNode({ batch, query, converge, state, roomKey }, '不同字段并行基线')
    const client = clients[2] || clients[0]
    const page = client.page
    const editor = await openEditor(client, fixture.uid)
    const textValue = `并行文本-${fixture.uid.slice(-6)}`
    const noteValue = `并行备注-${fixture.uid.slice(-6)}`
    await fillEditor(page, editor, textValue)
    const current = nodeFromQuery(await query(fixture.uid), fixture.uid).data
    const textExpected = { uid: fixture.uid, '__fv.text': Number(current.__fv?.text) || 0 }
    const noteExpected = { uid: fixture.uid, '__fv.note': Number(current.__fv?.note) || 0 }
    const session = await editorState(page)
    assert.equal(
      Number(session.session?.baseVersions?.text) || 0,
      textExpected['__fv.text'],
      'Browser text session did not capture the authoritative field version'
    )

    const [textSave, noteSave] = await Promise.all([
      hideEditor(page),
      call('update_node', {
        room_key: roomKey,
        node: fixture.uid,
        note: noteValue,
        expected: noteExpected
      })
    ])
    assert.equal(textSave, true, `Text edit did not save in parallel: ${JSON.stringify(textSave)}`)
    assert.equal(noteSave.toolError, false, `Independent note write conflicted: ${JSON.stringify(noteSave)}`)
    const revision = Number(await state())
    await converge(revision)
    const saved = nodeFromQuery(await query(fixture.uid), fixture.uid).data
    assert.ok(String(saved.text).includes(textValue), `Text field missing after parallel writes: ${JSON.stringify(saved)}`)
    assert.equal(saved.note, noteValue, `Note field missing after parallel writes: ${JSON.stringify(saved)}`)
    assert.ok(Number(saved.__fv?.text) > textExpected['__fv.text'], 'Text field version did not advance')
    assert.ok(Number(saved.__fv?.note) > noteExpected['__fv.note'], 'Note field version did not advance')
    const screenshot = path.join(OUT, 'interaction-independent-fields.png')
    await page.screenshot({ animations: 'disabled', path: screenshot, fullPage: false })
    return {
      uid: fixture.uid,
      textExpected,
      noteExpected,
      textVersion: saved.__fv?.text || 0,
      noteVersion: saved.__fv?.note || 0,
      savedText: saved.text,
      savedNote: saved.note,
      revision,
      screenshot
    }
  })
}
