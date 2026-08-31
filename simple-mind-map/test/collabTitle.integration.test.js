const assert = require('assert')
const crypto = require('crypto')

const baseUrl = process.env.COLLAB_TEST_BASE_URL || 'http://127.0.0.1:8080'
const roomKey = `test-title-${crypto.randomUUID()}`
const mapTitle = '独立标题-不应被覆盖'

async function request(path, options = {}) {
  const response = await fetch(baseUrl + path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  })
  const data = await response.json().catch(() => ({}))
  return { response, data }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  try {
    const created = await request('/api/files', {
      method: 'POST',
      body: JSON.stringify({
        room_key: roomKey,
        title: '初始标题',
        tree: { data: { uid: 'root', text: '根节点文字' }, children: [] }
      })
    })
    assert.strictEqual(created.response.status, 201)

    const renamed = await request(`/api/files/${encodeURIComponent(roomKey)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: mapTitle })
    })
    assert.strictEqual(renamed.response.status, 200)
    assert.strictEqual(renamed.data.title, mapTitle)

    const added = await request(`/api/files/${encodeURIComponent(roomKey)}/nodes`, {
      method: 'POST',
      body: JSON.stringify({ parent: 'root', text: '执行阶段' })
    })
    assert.strictEqual(added.response.status, 200)
    assert.strictEqual(added.data.title, mapTitle)

    const updated = await request(
      `/api/files/${encodeURIComponent(roomKey)}/nodes/${encodeURIComponent(added.data.uid)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ note: 'marker-after-rename' })
      }
    )
    assert.strictEqual(updated.response.status, 200)
    assert.strictEqual(updated.data.title, mapTitle)

    // 覆盖异步 scheduleSave：此前此处会把 title 写回根节点文字。
    await delay(2500)
    const fetched = await request(`/api/files/${encodeURIComponent(roomKey)}?format=full`)
    assert.strictEqual(fetched.response.status, 200)
    assert.strictEqual(fetched.data.title, mapTitle)
    assert.strictEqual(fetched.data.tree.children[0].data.note, 'marker-after-rename')

    console.log(`collab title integration passed (${roomKey})`)
  } finally {
    await request(`/api/files/${encodeURIComponent(roomKey)}`, { method: 'DELETE' })
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
