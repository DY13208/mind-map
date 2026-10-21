'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

function uid(label) {
  return `guard-note-link-${label}-${randomUUID().replace(/-/g, '').slice(0, 14)}`
}

function nodeFromQuery(result, expectedUid) {
  const nodes = result && (result.items || result.nodes)
  const item = Array.isArray(nodes)
    ? nodes.find(node => String(node.uid || node.data?.uid) === String(expectedUid)) || nodes[0]
    : null
  assert.ok(item, `query_nodes returned no node ${expectedUid}: ${JSON.stringify(result).slice(0, 800)}`)
  return item.data ? item : { ...item, data: item }
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
      if (vm.mindMap && vm.mindMap.cooperate && vm.mindMap.cooperate.collabV2Adapter) {
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

async function createNode({ batch, query, converge, state, roomKey }, label) {
  const nodeUid = uid(label)
  const result = await batch([{ op: 'add', node: nodeUid, parent: 'root', text: `MCP guard ${label}` }])
  assert.equal(result.toolError, false, `Failed to create ${label} fixture: ${JSON.stringify(result)}`)
  assert.equal(result.outcome, 'applied', `${label} fixture add was not applied: ${JSON.stringify(result)}`)
  const revision = Number(await state())
  await converge(revision)
  return { uid: nodeUid, item: nodeFromQuery(await query(nodeUid), nodeUid), roomKey }
}

async function openEditor(page, kind, nodeUid) {
  await page.evaluate(({ kind, nodeUid }) => {
    const root = document.querySelector('#app')
    const stack = [root && root.__vue__]
    const seen = new Set()
    let component = null
    while (stack.length) {
      const vm = stack.pop()
      if (!vm || seen.has(vm)) continue
      seen.add(vm)
      const isTarget = kind === 'note'
        ? !!(vm.$options && vm.$options.name === 'NodeNote')
        : typeof vm.handleShowNodeLink === 'function'
      if (isTarget) {
        component = vm
        break
      }
      stack.push(...(vm.$children || []))
    }
    const mindMap = window.__guardMM
    const node = mindMap && mindMap.renderer && mindMap.renderer.findNodeByUid(nodeUid)
    if (!component) throw new Error(`Mounted Vue editor component not found: ${kind}`)
    if (!node) throw new Error(`Rendered fixture node not found: ${nodeUid}`)
    if (!component.$bus || typeof component.$bus.$emit !== 'function') {
      throw new Error(`Vue editor event bus not available: ${kind}`)
    }
    // Use the same application event consumed by the real NodeNote/NodeHyperlink component.
    component.$bus.$emit(kind === 'note' ? 'showNodeNote' : 'showNodeLink', node)
  }, { kind, nodeUid })

  await page.waitForFunction(({ kind, nodeUid }) => {
    const root = document.querySelector('#app')
    const stack = [root && root.__vue__]
    const seen = new Set()
    while (stack.length) {
      const vm = stack.pop()
      if (!vm || seen.has(vm)) continue
      seen.add(vm)
      const isTarget = kind === 'note'
        ? !!(vm.$options && vm.$options.name === 'NodeNote')
        : typeof vm.handleShowNodeLink === 'function'
      if (isTarget) {
        const entry = (vm.sessions || []).find(item => String(item.uid) === String(nodeUid))
        return !!vm.dialogVisible && !!entry && !!entry.session
      }
      stack.push(...(vm.$children || []))
    }
    return false
  }, { kind, nodeUid }, { timeout: 15000 })

  const selector = kind === 'note' ? '.nodeNoteDialog:visible' : '.nodeHyperlinkDialog:visible'
  await page.locator(selector).waitFor({ state: 'visible', timeout: 15000 })
  return page.evaluate(({ kind, nodeUid }) => {
    const root = document.querySelector('#app')
    const stack = [root && root.__vue__]
    const seen = new Set()
    while (stack.length) {
      const vm = stack.pop()
      if (!vm || seen.has(vm)) continue
      seen.add(vm)
      const isTarget = kind === 'note'
        ? !!(vm.$options && vm.$options.name === 'NodeNote')
        : typeof vm.handleShowNodeLink === 'function'
      if (isTarget) {
        const entry = (vm.sessions || []).find(item => String(item.uid) === String(nodeUid))
        return {
          visible: !!vm.dialogVisible,
          session: entry && entry.session,
          localValues: kind === 'note'
            ? { note: vm.editor && vm.editor.getMarkdown ? vm.editor.getMarkdown() : vm.note }
            : { hyperlink: vm.link, hyperlinkTitle: vm.linkTitle }
        }
      }
      stack.push(...(vm.$children || []))
    }
    return null
  }, { kind, nodeUid })
}

async function readEditorState(page, kind, nodeUid) {
  return page.evaluate(({ kind, nodeUid }) => {
    const root = document.querySelector('#app')
    const stack = [root && root.__vue__]
    const seen = new Set()
    while (stack.length) {
      const vm = stack.pop()
      if (!vm || seen.has(vm)) continue
      seen.add(vm)
      const isTarget = kind === 'note'
        ? !!(vm.$options && vm.$options.name === 'NodeNote')
        : typeof vm.handleShowNodeLink === 'function'
      if (isTarget) {
        const entry = (vm.sessions || []).find(item => String(item.uid) === String(nodeUid))
        return {
          visible: !!vm.dialogVisible,
          session: entry && entry.session,
          note: vm.note,
          markdown: vm.editor && vm.editor.getMarkdown ? vm.editor.getMarkdown() : '',
          hyperlink: vm.link,
          hyperlinkTitle: vm.linkTitle,
          conflictCount: (vm.conflictEntries || []).length
        }
      }
      stack.push(...(vm.$children || []))
    }
    return null
  }, { kind, nodeUid })
}

async function fillNoteEditor(page, nodeUid, value) {
  const dialog = page.locator('.nodeNoteDialog:visible')
  const markdown = dialog.locator('.toastui-editor-md-container [contenteditable="true"]').first()
  let markdownVisible = false
  try {
    await markdown.waitFor({ state: 'visible', timeout: 5000 })
    markdownVisible = true
  } catch (_) {
    // Toast UI mounts its editing surface on the next tick; allow WYSIWYG-only layouts too.
  }
  if (markdownVisible) {
    await markdown.fill(value)
  } else {
    const wysiwyg = dialog.locator('.toastui-editor-ww-container [contenteditable="true"]').first()
    await wysiwyg.waitFor({ state: 'visible', timeout: 15000 })
    await wysiwyg.fill(value)
  }
  await page.waitForFunction(({ nodeUid, value }) => {
    const root = document.querySelector('#app')
    const stack = [root && root.__vue__]
    const seen = new Set()
    while (stack.length) {
      const vm = stack.pop()
      if (!vm || seen.has(vm)) continue
      seen.add(vm)
      if (vm.$options && vm.$options.name === 'NodeNote') {
        const entry = (vm.sessions || []).find(item => String(item.uid) === String(nodeUid))
        const text = vm.editor && vm.editor.getMarkdown ? vm.editor.getMarkdown() : ''
        return text.includes(value) && !!(entry && entry.session && entry.session.draft && String(entry.session.draft.note || '').includes(value))
      }
      stack.push(...(vm.$children || []))
    }
    return false
  }, { nodeUid, value }, { timeout: 15000 })
}

async function clickSave(page, kind) {
  const dialog = page.locator(kind === 'note' ? '.nodeNoteDialog:visible' : '.nodeHyperlinkDialog:visible')
  const save = dialog.locator('.el-dialog__footer .el-button--primary').last()
  await save.waitFor({ state: 'visible', timeout: 15000 })
  await save.click()
}

async function waitForConflictPanel(page, kind) {
  const dialog = page.locator(kind === 'note' ? '.nodeNoteDialog:visible' : '.nodeHyperlinkDialog:visible')
  await dialog.locator('.conflictDraftPanel').first().waitFor({ state: 'visible', timeout: 30000 })
}

async function showLatest(page, kind) {
  const dialog = page.locator(kind === 'note' ? '.nodeNoteDialog:visible' : '.nodeHyperlinkDialog:visible')
  const panel = dialog.locator('.conflictDraftPanel').first()
  await panel.locator('.draftActions .el-button').first().click()
  const latest = panel.locator('.latestSection')
  await latest.waitFor({ state: 'visible', timeout: 15000 })
  return latest.innerText()
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

async function remoteUpdate({ call, converge, state, query, roomKey }, nodeUid, group, fields) {
  const current = nodeFromQuery(await query(nodeUid), nodeUid).data
  const expectedVersion = Number((current.__fv && current.__fv[group]) || 0)
  const before = Number(await state())
  const result = await call('update_node', {
    room_key: roomKey,
    node: nodeUid,
    ...fields,
    expected: { uid: nodeUid, [`__fv.${group}`]: expectedVersion }
  })
  assert.equal(result.toolError, false, `Remote update failed: ${JSON.stringify(result)}`)
  const revision = Number(await state())
  assert.ok(revision > before, `Remote ${group} update did not create a revision: ${JSON.stringify(result)}`)
  await converge(revision)
  const saved = nodeFromQuery(await query(nodeUid), nodeUid).data
  return { result, before, revision, expectedVersion, saved }
}

module.exports = async function runNoteLinkGuardChecks({
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
  assert.ok(Array.isArray(clients) && clients.length >= 3, 'Note/link UI checks need three live browser clients')
  assert.equal(typeof call, 'function', 'MCP call helper is required')
  assert.equal(typeof query, 'function', 'query_nodes helper is required')
  assert.equal(typeof batch, 'function', 'apply_nodes helper is required')
  assert.equal(typeof converge, 'function', 'browser convergence helper is required')
  assert.equal(typeof state, 'function', 'room state helper is required')
  assert.equal(typeof check, 'function', 'check evidence helper is required')
  assert.ok(roomKey && origin && OUT, 'room key, browser origin, and evidence directory are required')
  const expectedOrigin = new URL(origin).origin
  for (const client of clients.slice(0, 3)) {
    assert.ok(client && client.page, 'Each browser client must expose its Playwright page')
    assert.equal(new URL(client.page.url()).origin, expectedOrigin, 'Browser is not on the harness origin')
    await waitForMap(client.page, Number(await state()))
  }

  await check('NodeNote Vue 组件：打开时捕获备注版本，冲突后保留草稿并可查看服务器内容', async () => {
    const fixture = await createNode({ batch, query, converge, state, roomKey }, 'note-conflict')
    const page = clients[0].page
    await waitForMap(page, Number(await state()))
    const base = nodeFromQuery(await query(fixture.uid), fixture.uid).data
    const baseVersion = Number((base.__fv && base.__fv.note) || 0)
    const localDraft = `本地备注草稿-${fixture.uid.slice(-6)}`
    const remoteNote = `协作者最新备注-${fixture.uid.slice(-6)}`

    const opened = await openEditor(page, 'note', fixture.uid)
    assert.equal(Number(opened.session.baseVersions.note) || 0, baseVersion, 'NodeNote did not capture note version on open')
    await fillNoteEditor(page, fixture.uid, localDraft)

    const remote = await remoteUpdate({ call, converge, state, query, roomKey }, fixture.uid, 'note', { note: remoteNote })
    assert.equal(Number(remote.expectedVersion), baseVersion, 'Remote writer did not use the opening baseline')
    assert.equal(remote.saved.note, remoteNote, 'Remote note update was not authoritative')
    assert.ok(Number((remote.saved.__fv && remote.saved.__fv.note) || 0) > baseVersion, 'Remote note field version did not advance')
    await waitForMap(page, remote.revision)

    await clickSave(page, 'note')
    await waitForConflictPanel(page, 'note')
    const afterConflict = await readEditorState(page, 'note', fixture.uid)
    assert.equal(afterConflict.visible, true, 'NodeNote dialog closed after a stale save')
    assert.ok(String(afterConflict.markdown).includes(localDraft), `NodeNote lost visible local draft: ${JSON.stringify(afterConflict)}`)
    assert.ok(String(afterConflict.session.draft.note).includes(localDraft), 'NodeNote conflict session lost its draft')
    assert.equal(Number(await state()), remote.revision, 'Rejected local note save created a server revision')
    const authoritative = nodeFromQuery(await query(fixture.uid), fixture.uid).data
    assert.equal(authoritative.note, remoteNote, 'Stale local note replaced the remote value')

    const latestPanel = await showLatest(page, 'note')
    assert.ok(latestPanel.includes(remoteNote), `Latest note is not viewable in the conflict panel: ${latestPanel}`)
    const records = await readStoredConflictDrafts(page, fixture.uid, roomKey)
    const savedDraft = records.find(record => String(record.value.session?.draft?.note || '').includes(localDraft))
    assert.ok(savedDraft, `IndexedDB did not retain NodeNote draft: ${JSON.stringify(records).slice(0, 1000)}`)
    const screenshot = path.join(OUT, 'mcp-guards-note-conflict.png')
    await page.screenshot({ path: screenshot, fullPage: false })
    return {
      uid: fixture.uid,
      capturedNoteVersion: baseVersion,
      remoteNoteVersion: Number((authoritative.__fv && authoritative.__fv.note) || 0),
      rejectedLocalSave: true,
      localDraft,
      latestVisible: latestPanel.includes(remoteNote),
      indexedDbKey: savedDraft.key,
      screenshot
    }
  })

  await check('NodeHyperlink Vue 组件：链接字段组按打开时版本冲突保护并保留 URL 与标题', async () => {
    const fixture = await createNode({ batch, query, converge, state, roomKey }, 'hyperlink-conflict')
    const page = clients[1].page
    await waitForMap(page, Number(await state()))
    const base = nodeFromQuery(await query(fixture.uid), fixture.uid).data
    const baseVersion = Number((base.__fv && base.__fv.hyperlink) || 0)
    const localUrl = `https://local-draft.example.test/${fixture.uid}`
    const localTitle = `本地链接标题-${fixture.uid.slice(-6)}`
    const remoteUrl = `https://remote-value.example.test/${fixture.uid}`
    const remoteTitle = `协作者链接标题-${fixture.uid.slice(-6)}`

    const opened = await openEditor(page, 'hyperlink', fixture.uid)
    assert.equal(Number(opened.session.baseVersions.hyperlink) || 0, baseVersion, 'NodeHyperlink did not capture hyperlink version on open')
    const dialog = page.locator('.nodeHyperlinkDialog:visible')
    await dialog.locator('form.linkForm input').nth(0).fill(localUrl)
    await dialog.locator('form.linkForm input').nth(1).fill(localTitle)
    await page.waitForFunction(({ nodeUid, localUrl, localTitle }) => {
      const root = document.querySelector('#app')
      const stack = [root && root.__vue__]
      const seen = new Set()
      while (stack.length) {
        const vm = stack.pop()
        if (!vm || seen.has(vm)) continue
        seen.add(vm)
        if (typeof vm.handleShowNodeLink === 'function') {
          const entry = (vm.sessions || []).find(item => String(item.uid) === String(nodeUid))
          return vm.link === localUrl && vm.linkTitle === localTitle &&
            !!(entry && entry.session && entry.session.draft &&
              entry.session.draft.hyperlink === localUrl &&
              entry.session.draft.hyperlinkTitle === localTitle)
        }
        stack.push(...(vm.$children || []))
      }
      return false
    }, { nodeUid: fixture.uid, localUrl, localTitle }, { timeout: 15000 })

    const remote = await remoteUpdate({ call, converge, state, query, roomKey }, fixture.uid, 'hyperlink', {
      hyperlink: remoteUrl,
      hyperlinkTitle: remoteTitle
    })
    assert.equal(remote.expectedVersion, baseVersion, 'Remote link writer did not use the opening baseline')
    assert.equal(remote.saved.hyperlink, remoteUrl, 'Remote URL update was not authoritative')
    assert.equal(remote.saved.hyperlinkTitle, remoteTitle, 'Remote link title update was not authoritative')
    assert.ok(Number((remote.saved.__fv && remote.saved.__fv.hyperlink) || 0) > baseVersion, 'Remote hyperlink version did not advance')
    await waitForMap(page, remote.revision)

    await clickSave(page, 'hyperlink')
    await waitForConflictPanel(page, 'hyperlink')
    const afterConflict = await readEditorState(page, 'hyperlink', fixture.uid)
    assert.equal(afterConflict.visible, true, 'NodeHyperlink dialog closed after a stale save')
    assert.equal(afterConflict.hyperlink, localUrl, 'NodeHyperlink lost local URL')
    assert.equal(afterConflict.hyperlinkTitle, localTitle, 'NodeHyperlink lost local title')
    assert.equal(afterConflict.session.draft.hyperlink, localUrl, 'Hyperlink conflict session lost URL draft')
    assert.equal(afterConflict.session.draft.hyperlinkTitle, localTitle, 'Hyperlink conflict session lost title draft')
    assert.equal(Number(await state()), remote.revision, 'Rejected local hyperlink save created a server revision')
    const authoritative = nodeFromQuery(await query(fixture.uid), fixture.uid).data
    assert.equal(authoritative.hyperlink, remoteUrl, 'Stale local URL replaced the remote URL')
    assert.equal(authoritative.hyperlinkTitle, remoteTitle, 'Stale local title replaced the remote title')

    const latestPanel = await showLatest(page, 'hyperlink')
    assert.ok(latestPanel.includes(remoteUrl) && latestPanel.includes(remoteTitle), `Latest hyperlink values are not viewable: ${latestPanel}`)
    const records = await readStoredConflictDrafts(page, fixture.uid, roomKey)
    const savedDraft = records.find(record =>
      record.value.session && record.value.session.draft &&
      record.value.session.draft.hyperlink === localUrl &&
      record.value.session.draft.hyperlinkTitle === localTitle
    )
    assert.ok(savedDraft, `IndexedDB did not retain NodeHyperlink draft: ${JSON.stringify(records).slice(0, 1000)}`)
    const screenshot = path.join(OUT, 'mcp-guards-hyperlink-conflict.png')
    await page.screenshot({ path: screenshot, fullPage: false })
    return {
      uid: fixture.uid,
      capturedHyperlinkVersion: baseVersion,
      remoteHyperlinkVersion: Number((authoritative.__fv && authoritative.__fv.hyperlink) || 0),
      rejectedLocalSave: true,
      localUrl,
      localTitle,
      latestVisible: latestPanel.includes(remoteUrl) && latestPanel.includes(remoteTitle),
      indexedDbKey: savedDraft.key,
      screenshot
    }
  })

  await check('NodeNote 正常路径：独立节点通过真实备注组件输入并提交', async () => {
    const fixture = await createNode({ batch, query, converge, state, roomKey }, 'note-normal')
    const page = clients[2].page
    await waitForMap(page, Number(await state()))
    const initial = nodeFromQuery(await query(fixture.uid), fixture.uid).data
    const initialVersion = Number((initial.__fv && initial.__fv.note) || 0)
    const initialRevision = Number(await state())
    const normalValue = `正常保存备注-${fixture.uid.slice(-6)}`

    const opened = await openEditor(page, 'note', fixture.uid)
    assert.equal(Number(opened.session.baseVersions.note) || 0, initialVersion, 'Normal NodeNote session did not capture its opening baseline')
    await fillNoteEditor(page, fixture.uid, normalValue)
    await clickSave(page, 'note')
    await page.locator('.nodeNoteDialog:visible').waitFor({ state: 'hidden', timeout: 30000 })

    const revision = Number(await state())
    assert.ok(revision > initialRevision, 'Normal note save did not produce a room revision')
    await converge(revision)
    await waitForMap(page, revision)
    const saved = nodeFromQuery(await query(fixture.uid), fixture.uid).data
    assert.equal(saved.note, normalValue, `Normal NodeNote save did not persist: ${JSON.stringify(saved)}`)
    assert.ok(Number((saved.__fv && saved.__fv.note) || 0) > initialVersion, 'Normal note field version did not advance')
    const screenshot = path.join(OUT, 'mcp-guards-note-normal.png')
    await page.screenshot({ path: screenshot, fullPage: false })
    return {
      uid: fixture.uid,
      initialNoteVersion: initialVersion,
      savedNoteVersion: Number((saved.__fv && saved.__fv.note) || 0),
      savedNote: saved.note,
      revision,
      screenshot
    }
  })
}
