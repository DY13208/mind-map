const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

const shellModeModule = fs
  .readFile(path.join(__dirname, '../src/utils/shellMode.js'), 'utf8')
  .then(source =>
    import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  )

test('shell mode uses a valid explicit URL value before entry defaults', async () => {
  const { resolveShellMode } = await shellModeModule

  assert.equal(resolveShellMode({ path: '/my-maps/folder/abc', query: {} }), 'focus')
  assert.equal(resolveShellMode({ path: '/', query: { room: 'legacy-room' } }), 'focus')
  assert.equal(resolveShellMode({ path: '/files/folder/abc', query: {} }), 'full')
  assert.equal(resolveShellMode({ path: '/', query: { room: 'room-1', shell: 'full' } }), 'full')
  assert.equal(resolveShellMode({ path: '/my-maps', query: { shell: 'full' } }), 'full')
  assert.equal(resolveShellMode({ path: '/files', query: { shell: 'embed' } }), 'embed')
  assert.equal(resolveShellMode({ path: '/files', query: { shell: 'unexpected' } }), 'full')
})

test('new in-app navigation inherits the source mode unless the target is explicit', async () => {
  const { resolveNavigationShell } = await shellModeModule

  assert.equal(
    resolveNavigationShell({ path: '/spaces', query: {} }, { path: '/my-maps/folder/abc', query: {} }),
    'focus'
  )
  assert.equal(
    resolveNavigationShell({ path: '/files', query: {} }, { path: '/spaces', query: { shell: 'embed' } }),
    'embed'
  )
  assert.equal(
    resolveNavigationShell(
      { path: '/files', query: { shell: 'full' } },
      { path: '/my-maps', query: { shell: 'focus' } }
    ),
    'full'
  )
})

test('history navigation follows the target entry instead of inheriting the page being left', async () => {
  const { resolveNavigationShell } = await shellModeModule

  assert.equal(
    resolveNavigationShell(
      { path: '/files', query: {} },
      { path: '/my-maps/folder/abc', query: { shell: 'focus' } },
      true
    ),
    'full'
  )
  assert.equal(
    resolveNavigationShell(
      { path: '/my-maps/folder/abc', query: { shell: 'embed' } },
      { path: '/files', query: { shell: 'full' } },
      true
    ),
    'embed'
  )
})

test('withShell preserves target parameters, hash, repeated queries, and explicit mode', async () => {
  const { withShell } = await shellModeModule
  const source = { path: '/my-maps/folder/abc', query: {} }

  assert.deepEqual(withShell('/files/folder/abc?team=t1&tag=a&tag=b#list', source), {
    path: '/files/folder/abc',
    query: { team: 't1', tag: ['a', 'b'], shell: 'focus' },
    hash: '#list'
  })
  assert.deepEqual(
    withShell({ path: '/files', query: { shell: 'embed', team: 't1' } }, source),
    { path: '/files', query: { shell: 'embed', team: 't1' } }
  )
})

test('withShell leaves external links untouched', async () => {
  const { withShell } = await shellModeModule

  assert.equal(
    withShell('https://example.com/maps', { path: '/my-maps', query: {} }),
    'https://example.com/maps'
  )
})

test('withShell uses the destination entry default when no source route is available', async () => {
  const { withShell } = await shellModeModule

  assert.deepEqual(withShell('/my-maps', null), {
    path: '/my-maps', query: { shell: 'focus' }
  })
})
