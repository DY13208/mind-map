const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..', 'src')
const routerSrc = fs.readFileSync(path.join(root, 'router.js'), 'utf8')
const toolbarSrc = fs.readFileSync(
  path.join(root, 'pages', 'Edit', 'components', 'Toolbar.vue'),
  'utf8'
)
const filesPageSrc = fs.readFileSync(
  path.join(root, 'pages', 'ProductShell', 'FilesPage.vue'),
  'utf8'
)

assert.match(routerSrc, /name:\s*'Edit'/)
assert.match(routerSrc, /beforeEnter/)
assert.match(routerSrc, /path:\s*'\/files'/)
assert.match(routerSrc, /next\(\{\s*path:\s*'\/files'/)
assert.match(routerSrc, /to\.query\.room/)
assert.match(routerSrc, /room:\s*to\.params\.roomKey/)
assert.match(routerSrc, /path:\s*'\/room\/:roomKey'/)
assert.match(routerSrc, /path:\s*'\/room-:roomSuffix'/)
assert.doesNotMatch(routerSrc, /redirect:\s*'\/files'/)

assert.match(toolbarSrc, /data-testid="back-to-files"/)
assert.match(toolbarSrc, /goToFiles\s*\(/)
assert.match(toolbarSrc, /path:\s*'\/files'/)
assert.match(toolbarSrc, /返回文件/)

assert.match(filesPageSrc, /query:\s*\{\s*room:\s*roomKey\s*\}/)
assert.match(filesPageSrc, /query:\s*\{\s*room:\s*created\.roomKey\s*\}/)
assert.match(filesPageSrc, /room\.roomKey\s*\|\|\s*room\.id/)

function decideRoot(to) {
  const room = to.query && to.query.room
  if (room == null || String(room).trim() === '') {
    return { path: '/files', replace: true }
  }
  return null
}

function roomPathRedirect(to) {
  return {
    path: '/',
    query: {
      ...(to.query || {}),
      room: to.params.roomKey
    }
  }
}

function resolveEntry(rawPath, query = {}) {
  const pathOnly = String(rawPath || '/')
  if (pathOnly === '/files') {
    return { path: '/files', name: 'Files', query: {} }
  }
  const roomMatch = pathOnly.match(/^\/room\/([^/]+)$/)
  if (roomMatch) {
    const redirected = roomPathRedirect({
      query,
      params: { roomKey: decodeURIComponent(roomMatch[1]) }
    })
    return resolveEntry(redirected.path, redirected.query)
  }
  const roomSuffix = pathOnly.match(/^\/room-(.+)$/)
  if (roomSuffix) {
    const redirected = roomPathRedirect({
      query,
      params: { roomKey: `room-${roomSuffix[1]}` }
    })
    return resolveEntry(redirected.path, redirected.query)
  }
  if (pathOnly === '/' || pathOnly === '') {
    const redirect = decideRoot({ query })
    if (redirect) {
      return { path: redirect.path, name: 'Files', query: {} }
    }
    return { path: '/', name: 'Edit', query }
  }
  throw new Error('unexpected path: ' + pathOnly)
}

assert.deepStrictEqual(resolveEntry('/'), {
  path: '/files',
  name: 'Files',
  query: {}
})
assert.deepStrictEqual(resolveEntry('/', { room: 'abc' }), {
  path: '/',
  name: 'Edit',
  query: { room: 'abc' }
})
assert.deepStrictEqual(resolveEntry('/room/abc'), {
  path: '/',
  name: 'Edit',
  query: { room: 'abc' }
})
assert.deepStrictEqual(resolveEntry('/room-xyz'), {
  path: '/',
  name: 'Edit',
  query: { room: 'room-xyz' }
})
assert.deepStrictEqual(resolveEntry('/files'), {
  path: '/files',
  name: 'Files',
  query: {}
})
assert.deepStrictEqual(resolveEntry('/', { room: 'from-shell' }), {
  path: '/',
  name: 'Edit',
  query: { room: 'from-shell' }
})
assert.equal(resolveEntry('/files').path, '/files')

console.log('Product shell router entry tests passed')
