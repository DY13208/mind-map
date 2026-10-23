'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function loadFieldMergeHelpers() {
  const file = path.join(__dirname, '../src/utils/fieldMerge.js')
  const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const groupStart = source.indexOf('export const FIELD_GROUPS =')
  const groupEnd = source.indexOf('\n\nexport const ALL_PATCH_KEYS', groupStart)
  const helpersStart = source.indexOf('export function fieldGroupOf')
  const helpersEnd = source.indexOf('\nexport function readFieldVersions', helpersStart)
  const stableStart = source.indexOf('function stableValue')
  const stableEnd = source.indexOf('\nexport function applyRemoteNodeData', stableStart)
  const deltaStart = source.indexOf('export function patchDelta')
  assert.ok(groupStart >= 0 && groupEnd > groupStart, 'fieldMerge field groups found')
  assert.ok(helpersStart >= 0 && helpersEnd > helpersStart, 'fieldMerge group helpers found')
  assert.ok(stableStart >= 0 && stableEnd > stableStart, 'fieldMerge stableValue found')
  assert.ok(deltaStart >= 0, 'fieldMerge.patchDelta found')

  const groups = source
    .slice(groupStart, groupEnd)
    .replace(/^export const/, 'const')
  const helpers = source
    .slice(helpersStart, helpersEnd)
    .replace(/^export function/gm, 'function')
  const stableValue = source.slice(stableStart, stableEnd)
  const patchDelta = source
    .slice(deltaStart)
    .replace(/^export function/gm, 'function')
  return vm.runInNewContext(`(() => {
    const FV_KEY = '__fv'
    ${groups}
    ${helpers}
    ${stableValue}
    ${patchDelta}
    return { fieldGroupOf, keysForGroups, patchDelta }
  })()`)
}

function loadNodePatchPayload(patchDelta, keysForGroups, fieldGroupOf) {
  const file = path.join(__dirname, '../src/plugins/Cooperate.js')
  const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const nullableMatch = source.match(/const NULLABLE_PATCH_KEYS = (\[[\s\S]*?\n\])/)
  assert.ok(nullableMatch, 'Cooperate nullable patch keys found')
  const nullablePatchKeys = vm.runInNewContext(nullableMatch[1])
  const start = source.indexOf('  nodePatchPayload(node, options = {}) {')
  const end = source.indexOf('\n  flushHttpText()', start)
  assert.ok(start >= 0 && end > start, 'Cooperate.nodePatchPayload source found')
  const methodSource = source
    .slice(start, end)
    .trim()
    .replace(/^nodePatchPayload/, 'function nodePatchPayload')

  return {
    source,
    nullablePatchKeys,
    method: vm.runInNewContext('(' + methodSource + ')', {
      NULLABLE_PATCH_KEYS: nullablePatchKeys,
      collabGeneralization: {
        snapshotValue: value => value,
        ownerGeneralizationPayload: value => value
      },
      collabNodeFeatures: {
        buildNodeContentFields: data => ({
          text: data.text,
          note: data.note,
          richText: data.richText
        }),
        publishRichTextPersistTrace() {},
        isEmptyFeatureValue: (_key, value) =>
          value === undefined || value === null || value === '',
        applyNullableGroupClears() {}
      },
      collabSpecialObjects: {
        canonicalImageFields: () => ({
          unresolvedKey: false,
          skipTransient: false,
          image: null,
          imageTitle: null,
          imageSize: null,
          storedImageValue: null
        }),
        publishImageTrace() {}
      },
      collectStyleFields: () => ({}),
      mapRefUtil: { normalizeMapRef: value => value },
      patchDelta,
      keysForGroups
    })
  }
}

function compileMethod(source, startText, endText, replacePattern, replacement, context) {
  const start = source.indexOf(startText)
  const end = source.indexOf(endText, start)
  assert.ok(start >= 0 && end > start, `${startText.trim()} source found`)
  const methodSource = source
    .slice(start, end)
    .trim()
    .replace(replacePattern, replacement)
  return vm.runInNewContext('(' + methodSource + ')', context)
}

function makeNode(data) {
  return {
    getData(key) {
      return key ? data[key] : data
    },
    getImageUrl() {
      return ''
    }
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

async function main() {
  const { fieldGroupOf, keysForGroups, patchDelta } = loadFieldMergeHelpers()
  const {
    source,
    nullablePatchKeys,
    method: nodePatchPayload
  } = loadNodePatchPayload(
    patchDelta,
    keysForGroups,
    fieldGroupOf
  )
  const attachmentGroup = fieldGroupOf('attachmentId')
  const groupKeys = Array.from(keysForGroups([attachmentGroup]))
  assert.ok(!nullablePatchKeys.includes('attachmentProgress'))
  const hasUnsyncedLocalText = compileMethod(
    source,
    '  hasUnsyncedLocalText(node) {',
    '\n  isHttpTextRendererReady()',
    /^hasUnsyncedLocalText/,
    'function hasUnsyncedLocalText',
    { fieldGroupOf }
  )
  const collectNodesWithPendingText = compileMethod(
    source,
    '  collectNodesWithPendingText() {',
    '\n  collectActivePendingText()',
    /^collectNodesWithPendingText/,
    'function collectNodesWithPendingText',
    {}
  )
  const onAfterExecCommand = compileMethod(
    source,
    '  onAfterExecCommand(name) {',
    '\n  flushLocalNow()',
    /^onAfterExecCommand/,
    'function onAfterExecCommand',
    {
      FIELD_COMMANDS: { SET_NODE_ATTACHMENT: true },
      INSERT_COMMANDS: {},
      MOVE_COMMANDS: {},
      STRUCTURE_COMMANDS: {}
    }
  )
  const flushHttpTextOnce = compileMethod(
    source,
    '  async flushHttpTextOnce(options = {}) {',
    '\n  snapshotV2InsertCollect()',
    /^async flushHttpTextOnce/,
    'async function flushHttpTextOnce',
    {
      fieldGroupOf,
      collabGeneralization: { snapshotValue: value => value },
      PATCH_CONCURRENCY: 1,
      runPromisePool: async jobs => Promise.all(jobs.map(job => job())),
      isPermanentNodeError: () => false
    }
  )
  const uid = 'node-attachment-1'
  const baseline = {
    text: 'same node text',
    note: '',
    attachmentUrl: '/attachments/att-7',
    attachmentName: 'brief.docx',
    attachmentId: 'att-7',
    attachmentMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    attachmentStatus: 'ready',
    attachmentExtractedText: 'existing extracted text',
    attachmentErrorIgnored: false
  }
  const data = {
    ...baseline,
    uid,
    attachmentProgress: 38
  }
  const node = makeNode(data)
  const instance = {
    lastPushed: { [uid]: { full: baseline } },
    resolveHttpPatchNode: value => value,
    nodePatchPayload,
    hasUnsyncedLocalText,
    collectNodesWithPendingText,
    mindMap: {
      renderer: {
        renderTree: { data: { imgMap: {} } },
        activeNodeList: [],
        findNodeByUid: candidateUid => candidateUid === uid ? node : null,
        _lazyCommandPending: false
      }
    },
    collabV2Adapter: {},
    httpCollabMode: true,
    isApplyingRemote: false,
    isSetData: false,
    httpReplacing: false,
    suppressLocalUntil: 0,
    httpSettlingAfterReplace: false,
    _pendingTextUids: new Set(),
    _pendingAttachmentPatchByUid: new Map(),
    commandIntentUids: () => [uid],
    recordLocalIntentUids() {},
    onHttpCommand() {},
    scheduleHttpTextSync() {
      this.httpTextScheduled = true
    },
    isHttpTextRendererReady: () => true,
    isPersistAcked: () => true,
    httpPatchNode: async (_uid, patch) => {
      submitted.push(plain(patch))
    },
    _inflightTextKeys: new Map(),
    _disposed: false
  }
  const submitted = []

  // DELETE cleared the server attachment, while lastPushed still contains the
  // pre-delete snapshot. A same-content deduplicated upload restores the same
  // attachment values locally, so ordinary delta comparison emits nothing.
  assert.equal(nodePatchPayload.call(instance, node, { onlyChanged: true }), null)
  assert.equal(instance.hasUnsyncedLocalText(node), false)
  instance.commandIntentUids = () => [uid]
  onAfterExecCommand.call(instance, 'SET_NODE_ATTACHMENT', node)
  assert.equal(instance.httpTextScheduled, true)
  assert.equal(instance._pendingTextUids.has(uid), true)
  assert.equal(
    instance.hasUnsyncedLocalText(node),
    true,
    'an explicit attachment intent keeps the node in the pending delta queue'
  )
  instance.collabV2Adapter = null
  instance.collectVisibleUids = () => []
  assert.deepEqual(
    Array.from(instance.collectNodesWithPendingText()),
    [node],
    'HTTP collaboration without a V2 adapter still collects explicit attachment intents'
  )
  instance.collabV2Adapter = {}

  // Flush through the real queue and submission code. The explicit command
  // adds the whole attachment group; poll-only progress stays out of ordinary
  // node deltas after this intent is acknowledged.
  instance.flushHttpTextOnce = flushHttpTextOnce
  await instance.flushHttpTextOnce()
  const reattached = submitted[0]
  assert.ok(reattached)
  assert.deepEqual(Object.keys(reattached).filter(key => groupKeys.includes(key)).sort(), groupKeys.slice().sort())
  assert.equal(reattached.attachmentId, 'att-7')
  assert.equal(reattached.attachmentMimeType, baseline.attachmentMimeType)
  assert.equal(reattached.attachmentStatus, 'ready')
  assert.equal(reattached.attachmentUrl, '/attachments/att-7')
  assert.equal(reattached.attachmentName, 'brief.docx')
  assert.equal(reattached.attachmentProgress, 38)
  assert.equal(reattached.attachmentError, null)
  assert.equal(instance._pendingAttachmentPatchByUid.has(uid), false)
  assert.equal(nodePatchPayload.call(instance, node, { onlyChanged: true }), null)

  data.text = 'an ordinary text edit'
  assert.deepEqual(plain(nodePatchPayload.call(instance, node, { onlyChanged: true })), {
    text: 'an ordinary text edit'
  }, 'ordinary text updates remain minimal')
  await instance.flushHttpTextOnce()
  assert.deepEqual(submitted[1], { text: 'an ordinary text edit' })

  assert.match(
    source,
    /this\.httpCollabMode\s*&&[\s\S]*?name === 'SET_NODE_ATTACHMENT'/
  )
  assert.match(
    source,
    /forceGroups: attachmentPatchRevision\s*\?\s*\[fieldGroupOf\('attachmentId'\)\]/
  )
  const commandSource = fs.readFileSync(
    path.join(__dirname, '../src/core/command/Command.js'),
    'utf8'
  )
  assert.ok(
    commandSource.indexOf("this.mindMap.emit('afterExecCommand', name, ...args)") <
      commandSource.indexOf('this.recordContentChange({ nodes: [value] })'),
    'the attachment intent is marked before incremental data_change queues the UID'
  )
  console.log('collab attachment atomic patch tests passed')
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
