const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')
const esbuild = require('../node_modules/esbuild')

async function loadSnapshotApi() {
  const repo = path.resolve(__dirname, '../..')
  const result = await esbuild.build({
    absWorkingDir: path.join(repo, 'web'),
    entryPoints: ['src/utils/historySnapshot.js'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    alias: {
      'simple-mind-map/src/utils/collabPaste': path.join(
        repo,
        'simple-mind-map/src/utils/collabPaste.js'
      )
    }
  })
  const moduleRef = new Module(path.join(__dirname, 'historySnapshot.bundle.cjs'), module)
  moduleRef.filename = path.join(__dirname, 'historySnapshot.bundle.cjs')
  moduleRef.paths = Module._nodeModulePaths(path.dirname(moduleRef.filename))
  moduleRef._compile(result.outputFiles[0].text, moduleRef.filename)
  return moduleRef.exports
}

function makeTree() {
  const root = {
    data: {
      uid: 'root',
      text: 'History root',
      imgMap: { smm_img_key_history: 'data:image/png;base64,history' },
      isActive: true
    },
    children: []
  }
  for (let i = 0; i < 55; i++) {
    root.children.push({
      data: {
        uid: `branch-${i}`,
        text: `Branch ${i}`,
        expand: i !== 0,
        isActive: i === 0,
        associativeLineTargets: i === 0
          ? ['branch-1', 'leaf-0', 'outside']
          : [],
        associativeLineText: i === 0 ? ['to selected', 'to child', 'external'] : []
      },
      _rendererCache: { stale: true },
      children: i === 0
        ? [
            {
              data: {
                uid: 'leaf-0',
                text: 'Collapsed descendant',
                note: 'note',
                richText: true,
                image: 'smm_img_key_history',
                attachmentId: 'attachment-history',
                inserting: true
              },
              children: [
                { data: { uid: 'leaf-0-deep', text: 'Deep child' }, children: [] }
              ]
            }
          ]
        : i === 1
          ? [{ data: { uid: 'leaf-1', text: 'Selected root child' }, children: [] }]
          : [],
      ...(i === 0
        ? {
            data: undefined
          }
        : {})
    })
  }
  // Keep the node's business data while adding a summary child with a virtual UID.
  root.children[0].data = {
    uid: 'branch-0',
    text: 'Branch 0',
    expand: false,
    isActive: true,
    associativeLineTargets: ['branch-1', 'leaf-0', 'outside'],
    associativeLineText: ['to selected', 'to child', 'external'],
    associativeLineStyle: [{ id: 1 }, { id: 2 }, { id: 3 }],
    generalization: [
      {
        uid: 'summary-0',
        text: 'Summary',
        isActive: true,
        children: [{ data: { uid: 'summary-child', text: 'Summary child' }, children: [] }]
      }
    ]
  }
  root.children[1].data.associativeLineTargets = ['branch-0']
  return root
}

async function main() {
  const {
    prepareHistorySnapshot,
    summarizeHistoryBranches,
    extractHistoryBranches
  } = await loadSnapshotApi()

  const source = makeTree()
  const before = JSON.stringify(source)
  const snapshot = prepareHistorySnapshot(source, {})
  assert.notEqual(snapshot.tree, source)
  assert.notEqual(snapshot.tree.children[0], source.children[0])
  assert.deepEqual(JSON.parse(JSON.stringify(source)), JSON.parse(before))
  assert.equal(snapshot.index['branch-54'].data.uid, 'branch-54')
  assert.equal(snapshot.tree.children[0].data.expand, false)
  assert.equal(snapshot.tree.children[0].children[0].children.length, 1)
  assert.equal(snapshot.tree.children[0].children[0].data.isActive, undefined)
  assert.equal(snapshot.tree.children[0].children[0].data.inserting, undefined)
  assert.equal(snapshot.tree.children[0]._rendererCache, undefined)
  assert.equal(
    snapshot.tree.children[0].children[0].data.image,
    'data:image/png;base64,history'
  )
  assert.equal(snapshot.tree.children[0].children[0].data.attachmentId, 'attachment-history')
  assert.equal(snapshot.tree.children[0].data.generalization[0].isActive, undefined)

  const summary = summarizeHistoryBranches(snapshot, [
    'leaf-0',
    'branch-1',
    'branch-0',
    'branch-0'
  ])
  assert.deepEqual(summary, {
    branchCount: 2,
    nodeCount: 6,
    uids: ['branch-0', 'branch-1']
  })
  const extracted = extractHistoryBranches(snapshot, summary.uids)
  assert.equal(extracted.branchCount, 2)
  assert.equal(extracted.nodeCount, 6)
  assert.deepEqual(extracted.trees.map(node => node.data.uid), ['branch-0', 'branch-1'])
  assert.deepEqual(extracted.trees[0].data.associativeLineTargets, ['branch-1', 'leaf-0'])
  assert.deepEqual(extracted.trees[0].data.associativeLineText, ['to selected', 'to child'])
  assert.deepEqual(extracted.trees[0].data.associativeLineStyle, [{ id: 1 }, { id: 2 }])
  assert.deepEqual(extracted.trees[1].data.associativeLineTargets, ['branch-0'])
  extracted.trees[0].data.text = 'changed copy'
  assert.equal(snapshot.tree.children[0].data.text, 'Branch 0')
  assert.equal(source.children[0].data.text, 'Branch 0')

  const lastRoot = summarizeHistoryBranches(snapshot, ['branch-54'])
  assert.deepEqual(lastRoot, { branchCount: 1, nodeCount: 1, uids: ['branch-54'] })
  assert.throws(
    () => summarizeHistoryBranches(snapshot, ['__history_preview_more__']),
    error => error.code === 'HISTORY_SELECTION_UID_NOT_FOUND'
  )
  assert.throws(
    () => summarizeHistoryBranches(snapshot, ['missing-uid']),
    error => error.code === 'HISTORY_SELECTION_UID_NOT_FOUND'
  )
  assert.throws(
    () => summarizeHistoryBranches(snapshot, ['summary-0']),
    error => error.code === 'HISTORY_GENERALIZATION_SELECTION_UNSUPPORTED'
  )

  const missingImageSource = makeTree()
  missingImageSource.children[2].data.image = 'smm_img_key_missing'
  const missingImageSnapshot = prepareHistorySnapshot(missingImageSource)
  const missingImageSnapshotBefore = JSON.stringify(missingImageSnapshot.tree)
  assert.equal(
    missingImageSnapshot.tree.children[2].data.image,
    'smm_img_key_missing',
    'structural history data should retain an unresolved private image key'
  )
  assert.throws(
    () => extractHistoryBranches(missingImageSnapshot, ['branch-2']),
    error =>
      error.code === 'HISTORY_IMAGE_UNAVAILABLE' &&
      error.uid === 'branch-2' &&
      error.imageKey === 'smm_img_key_missing'
  )
  const imageFreeBranch = extractHistoryBranches(missingImageSnapshot, ['branch-1'])
  assert.deepEqual(imageFreeBranch.trees.map(node => node.data.uid), ['branch-1'])
  assert.equal(imageFreeBranch.nodeCount, 2)
  assert.throws(
    () => extractHistoryBranches(missingImageSnapshot, ['root']),
    error => error.code === 'HISTORY_IMAGE_UNAVAILABLE'
  )
  assert.equal(JSON.stringify(missingImageSnapshot.tree), missingImageSnapshotBefore)

  const flat = prepareHistorySnapshot({
    root: { isRoot: true, data: { uid: 'root' }, children: ['flat-branch'] },
    'flat-branch': { data: { text: 'Flat branch' }, children: [] }
  })
  assert.equal(flat.tree.children[0].data.uid, 'flat-branch')
  assert.equal(flat.tree.children[0].data.expand, true)
  assert.throws(
    () => prepareHistorySnapshot({
      root: { isRoot: true, data: { uid: 'wrong-root' }, children: [] }
    }),
    error => error.code === 'HISTORY_NODE_UID_MISMATCH'
  )
  assert.throws(
    () => prepareHistorySnapshot({ data: { uid: 'broken' } }),
    error => error.code === 'HISTORY_SNAPSHOT_INVALID'
  )

  console.log('PASS: history snapshot indexing, image mapping and availability, and UID safety')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
