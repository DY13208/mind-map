const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const assert = require('node:assert/strict')

function loadModule(file) {
  const source = fs.readFileSync(path.resolve(__dirname, file), 'utf8')
  const exports = Array.from(
    source.matchAll(/export (?:const|function) ([A-Za-z0-9_]+)/g)
  ).map(match => match[1])
  const context = { module: { exports: {} } }
  vm.runInNewContext(
    `${source.replace(/\bexport\s+/g, '')}\nmodule.exports = { ${exports.join(
      ', '
    )} }`,
    context
  )
  return context.module.exports
}

const layout = loadModule(
  '../src/pages/ProductShell/components/mobileFolderLayout.js'
)
const navigation = loadModule(
  '../src/pages/ProductShell/components/mobileFilesNavigation.js'
)
const shellMode = loadModule('../src/utils/shellMode.js')

let count = 0
function test(name, fn) {
  fn()
  count++
  console.log('PASS', name)
}

test('folder stage fits the width when width is the limiting dimension', () => {
  const fitted = layout.fitFolderStage(170, 272)
  assert.equal(fitted.scale, 0.5)
  assert.equal(fitted.width, 170)
  assert.equal(fitted.height, 136)
  assert.equal(fitted.width / fitted.height, layout.FOLDER_STAGE_WIDTH / layout.FOLDER_STAGE_HEIGHT)
})

test('mobile folder stage fills the card width with the source aspect ratio', () => {
  const cardWidth = 177
  const cardHeight = Math.round((layout.FOLDER_STAGE_HEIGHT * cardWidth) / layout.FOLDER_STAGE_WIDTH)
  const fitted = layout.fitFolderStage(cardWidth, cardHeight)
  assert.equal(cardHeight, 142)
  assert.ok(Math.abs(fitted.width - cardWidth) < 1e-9)
  assert.ok(fitted.height <= cardHeight)
  assert.ok(
    Math.abs(
      fitted.width / fitted.height -
        layout.FOLDER_STAGE_WIDTH / layout.FOLDER_STAGE_HEIGHT
    ) < 1e-12
  )
})

test('width-fit keeps the folder bottom exactly on the card bottom', () => {
  const fitted = layout.fitFolderStageToWidth(274)
  assert.equal(fitted.width, 274)
  assert.ok(Math.abs(fitted.height - 219.2) < 1e-9)
  assert.ok(Math.abs(fitted.height - (274 * layout.FOLDER_STAGE_HEIGHT) / layout.FOLDER_STAGE_WIDTH) < 1e-9)
})

test('folder stage still respects a height limit without distortion', () => {
  const fitted = layout.fitFolderStage(168, 110)
  assert.equal(fitted.scale, 110 / layout.FOLDER_STAGE_HEIGHT)
  assert.ok(fitted.width < 168)
  assert.ok(Math.abs(fitted.height - 110) < 1e-9)
  assert.ok(
    Math.abs(
      fitted.width / fitted.height -
        layout.FOLDER_STAGE_WIDTH / layout.FOLDER_STAGE_HEIGHT
    ) < 1e-12
  )
})

test('view targets support /files and /my-maps without inventing routes', () => {
  assert.equal(navigation.mobileViewTarget('/files', 'files').path, '/files')
  assert.equal(
    navigation.mobileViewTarget('/files', 'recent').path,
    '/files/recent'
  )
  assert.equal(
    navigation.mobileViewTarget('/my-maps', 'favorites').path,
    '/my-maps/favorites'
  )
  assert.equal(navigation.mobileViewTarget('/my-maps', 'files').path, '/my-maps')
  assert.equal(
    navigation.mobileViewTarget('/my-maps', 'recent').path,
    '/files/recent'
  )
  assert.equal(
    navigation.mobileViewTarget('/my-maps', 'shared').path,
    '/files/shared'
  )
})

test('parent navigation keeps team and shell but drops unrelated query', () => {
  const path = [
    { id: 'folder-a', name: '一级' },
    { id: 'folder-b', name: '二级' }
  ]
  const target = navigation.mobileParentTarget('/my-maps', path, {
    team: 'team-1'
  })
  const location = shellMode.withShell(target, {
    path: '/my-maps/folder/folder-b',
    query: { team: 'team-1', shell: 'focus', nav: 'abc', returnTo: '/files' }
  })
  assert.equal(location.path, '/my-maps/folder/folder-a')
  assert.equal(
    JSON.stringify(location.query),
    JSON.stringify({ team: 'team-1', shell: 'focus' })
  )
})

test('one-level parent and personal view entries do not carry folder context', () => {
  const target = navigation.mobileParentTarget(
    '/my-maps',
    [{ id: 'folder-a', name: '一级' }],
    { team: '' }
  )
  assert.equal(target.path, '/my-maps')
  assert.equal(target.query, undefined)
  const personal = navigation.mobileViewTarget('/my-maps', 'files', {
    team: ''
  })
  const location = shellMode.withShell(personal, {
    path: '/my-maps/folder/folder-a',
    query: { shell: 'focus', nav: 'abc', returnTo: '/files' }
  })
  assert.equal(location.path, '/my-maps')
  assert.equal(
    JSON.stringify(location.query),
    JSON.stringify({ shell: 'focus' })
  )
})

test('same destinations do not navigate; unrelated query does not matter', () => {
  const target = navigation.mobileRootTarget('/files', { team: 'team-1' })
  const location = shellMode.withShell(target, {
    path: '/files',
    query: { shell: 'full' }
  })
  assert.equal(
    navigation.shouldNavigateMobile(location, {
      path: '/files',
      query: { team: 'team-1', shell: 'full', nav: 'abc' }
    }),
    false
  )
  assert.equal(
    navigation.shouldNavigateMobile(location, {
      path: '/files/folder/folder-a',
      query: { team: 'team-1', shell: 'full' }
    }),
    true
  )
})

test('path ancestors exclude the current folder and panel state is exclusive', () => {
  const path = [
    { id: 'folder-a', name: '一级' },
    { id: 'folder-b', name: '二级' }
  ]
  assert.equal(navigation.isFolderPathAncestor(path, 0), true)
  assert.equal(navigation.isFolderPathAncestor(path, 1), false)
  assert.equal(navigation.isFolderPathAncestor(path, 2), false)
  assert.equal(navigation.toggleMobilePanel(null, 'more'), 'more')
  assert.equal(navigation.toggleMobilePanel('more', 'path'), 'path')
  assert.equal(navigation.toggleMobilePanel('path', 'path'), null)
  assert.equal(navigation.toggleMobilePanel('more', 'more'), null)
  assert.equal(navigation.updateMobilePanel(null, 'more', true), 'more')
  assert.equal(navigation.updateMobilePanel('more', 'path', true), 'path')
  assert.equal(navigation.updateMobilePanel('more', 'more', true), 'more')
  assert.equal(navigation.updateMobilePanel('path', 'path', false), null)
  assert.equal(navigation.updateMobilePanel('more', 'path', false), 'more')
})

console.log(`${count} mobile files UI regressions passed`)
