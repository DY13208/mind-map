const assert = require('assert')
const fs = require('fs')
const path = require('path')
const Module = require('module')

const root = path.join(__dirname, '..', 'src')

function loadEsmAsCjs(relPath) {
  const abs = path.join(root, relPath)
  const code = fs.readFileSync(abs, 'utf8')
  const transformed = code
    .replace(/export function /g, 'function ')
    .replace(
      /export \{([^}]+)\}/g,
      (_, names) =>
        names
          .split(',')
          .map(n => n.trim())
          .filter(Boolean)
          .map(n => `exports.${n} = ${n}`)
          .join('\n')
    )
  // named export function already rewritten; attach exports at end for each function
  const names = [
    'roomFromHashPath',
    'roomFromPathname',
    'roomFromLocation',
    'buildInviteUrl',
    'migrateLegacyHashUrl'
  ]
  const footer = names
    .map(n => `if (typeof ${n} === 'function') exports.${n} = ${n}`)
    .join('\n')
  const module = { exports: {} }
  const fn = new Function('exports', 'module', 'require', transformed + '\n' + footer)
  fn(module.exports, module, require)
  return module.exports
}

const {
  roomFromHashPath,
  roomFromPathname,
  roomFromLocation,
  buildInviteUrl,
  migrateLegacyHashUrl
} = loadEsmAsCjs('utils/roomLocation.js')

assert.equal(roomFromHashPath('#/room-abc'), 'room-abc')
assert.equal(roomFromHashPath('#/room/room-xyz'), 'room-xyz')
assert.equal(roomFromPathname('/room/room-xyz'), 'room-xyz')
assert.equal(roomFromPathname('/room-abc'), 'room-abc')

assert.equal(
  buildInviteUrl('room-1', 'http://xx.stillgroup.net:8989'),
  'http://xx.stillgroup.net:8989/?room=room-1'
)
assert.ok(!buildInviteUrl('room-1', 'http://x').includes('#'))

const fakeLoc = {
  pathname: '/',
  search: '',
  hash: '#/?room=room-abc'
}
const hist = { replaceStateCalls: [], replaceState(_s, _t, url) {
  this.replaceStateCalls.push(url)
  const u = new URL(url, 'http://example.test')
  fakeLoc.pathname = u.pathname
  fakeLoc.search = u.search
  fakeLoc.hash = ''
}}
assert.equal(
  migrateLegacyHashUrl(fakeLoc, hist),
  '/?room=room-abc'
)
assert.equal(fakeLoc.hash, '')
assert.deepStrictEqual(hist.replaceStateCalls, ['/?room=room-abc'])

fakeLoc.pathname = '/'
fakeLoc.search = ''
fakeLoc.hash = '#/files'
assert.equal(migrateLegacyHashUrl(fakeLoc, hist), '/files')

fakeLoc.pathname = '/'
fakeLoc.search = ''
fakeLoc.hash = '#/room-abc'
assert.equal(migrateLegacyHashUrl(fakeLoc, hist), '/?room=room-abc')

fakeLoc.pathname = '/'
fakeLoc.search = ''
fakeLoc.hash = '#/'
assert.equal(migrateLegacyHashUrl(fakeLoc, hist), '/')

// Priority: route query > search > pathname > hash
global.window = {
  location: {
    search: '?room=from-search',
    pathname: '/room/path-room',
    hash: '#/?room=from-hash'
  }
}
assert.equal(roomFromLocation({ query: { room: 'from-route' } }), 'from-route')
assert.equal(roomFromLocation({ query: {} }), 'from-search')
global.window.location.search = ''
assert.equal(roomFromLocation(null), 'room-path-room')
global.window.location.pathname = '/'
assert.equal(roomFromLocation(null), 'from-hash')

const roomDtoCode = fs
  .readFileSync(path.join(root, 'services', 'roomDto.js'), 'utf8')
  .replace(/export function /g, 'function ')
const roomDtoMod = { exports: {} }
new Function(
  'exports',
  'module',
  roomDtoCode +
    '\nexports.normalizeRoomDto = normalizeRoomDto\nexports.requireRoomKey = requireRoomKey\nexports.isSharedWithMe = isSharedWithMe\nexports.normalizeRole = normalizeRole\nexports.normalizeFolderId = normalizeFolderId\nexports.displayRole = displayRole\n'
)(roomDtoMod.exports, roomDtoMod)
const { normalizeRoomDto, requireRoomKey } = roomDtoMod.exports

const legacy = normalizeRoomDto({
  room_key: 'room-legacy',
  title: 'L',
  updated_at: '2026-01-01T00:00:00.000Z',
  role: 'owner',
  canManage: true
})
assert.equal(legacy.roomKey, 'room-legacy')
assert.equal(legacy.updatedAt, '2026-01-01T00:00:00.000Z')
assert.equal(requireRoomKey(legacy), 'room-legacy')
assert.equal(requireRoomKey({ room_key: 'room-x' }), 'room-x')
assert.throws(() => requireRoomKey({}), err => err.code === 'INVALID_ROOM_KEY')
assert.throws(
  () => requireRoomKey({ roomKey: 'undefined' }),
  err => err.code === 'INVALID_ROOM_KEY'
)

const dialogSrc = fs.readFileSync(
  path.join(root, 'pages', 'Edit', 'components', 'CooperateDialog.vue'),
  'utf8'
)
assert.match(dialogSrc, /:key="item\.roomKey"/)
assert.match(dialogSrc, /roomName === item\.roomKey/)
assert.match(dialogSrc, /requireRoomKey/)
assert.match(dialogSrc, /roomService\.renameRoom/)
assert.match(dialogSrc, /roomService\.deleteRoom/)
assert.match(dialogSrc, /buildInviteUrl/)
assert.match(dialogSrc, /path:\s*'\/files'/)
assert.doesNotMatch(dialogSrc, /item\.room_key/)
assert.doesNotMatch(dialogSrc, /\/#\/\?room=/)
assert.doesNotMatch(dialogSrc, /renameFileApi/)
assert.doesNotMatch(dialogSrc, /deleteFileApi/)

const fileApiSrc = fs.readFileSync(
  path.join(root, 'utils', 'fileApi.js'),
  'utf8'
)
assert.match(fileApiSrc, /\/trash/)
assert.match(fileApiSrc, /method:\s*'POST'/)

const toolbarSrc = fs.readFileSync(
  path.join(root, 'pages', 'Edit', 'components', 'Toolbar.vue'),
  'utf8'
)
assert.match(toolbarSrc, /data-testid="back-to-files"/)
assert.match(toolbarSrc, /data-testid="share"/)
assert.match(toolbarSrc, /返回首页/)
assert.ok(
  toolbarSrc.indexOf('data-testid="share"') <
    toolbarSrc.indexOf('data-testid="back-to-files"'),
  '返回首页 must be to the right of 分享/权限'
)

const routerSrc = fs.readFileSync(path.join(root, 'router.js'), 'utf8')
assert.match(routerSrc, /mode:\s*'history'/)
assert.match(routerSrc, /migrateLegacyHashUrl/)

const nginxSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'docker', 'nginx.conf'),
  'utf8'
)
assert.match(nginxSrc, /try_files \$uri \$uri\/ \/index\.html/)
assert.match(nginxSrc, /location \/api\//)
assert.match(nginxSrc, /location \/collab-v2/)

console.log('Editor product shell integration contract tests passed')
