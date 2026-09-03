const { comparePositions } = require('../fractionalIndex')

function emptyGraph() {
  return {
    root: {
      isRoot: true,
      data: { uid: 'root', text: '未命名' },
      children: []
    }
  }
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isSopLabel(data) {
  return stripHtml(data && data.text).toLowerCase() === 'sop'
}

function createMemoryStore(graph) {
  const stats = { queries: 0, reads: 0, writes: 0 }
  const rows = new Map()
  const childIndex = new Map()
  const g = graph && typeof graph === 'object' ? graph : emptyGraph()
  const parentOf = new Map()
  Object.keys(g).forEach(uid => {
    const kids = Array.isArray(g[uid] && g[uid].children) ? g[uid].children.slice() : []
    childIndex.set(uid, kids)
    kids.forEach(child => parentOf.set(child, uid))
  })
  Object.keys(g).forEach(uid => {
    const node = g[uid] || {}
    rows.set(uid, {
      uid,
      parent_uid: parentOf.get(uid) || null,
      position: node.position || '',
      data: { ...(node.data || {}), uid },
      is_root: !!node.isRoot || uid === 'root',
      deleted: !!node.deleted,
      node_version: 0
    })
  })
  let rootUid = null
  rows.forEach(row => {
    if (row.is_root && !row.deleted) rootUid = row.uid
  })

  function touch() {
    stats.queries += 1
  }

  function childRows(parentUid) {
    return (childIndex.get(parentUid) || [])
      .map(id => rows.get(id))
      .filter(row => row && !row.deleted)
      .sort((a, b) => comparePositions(a.position, b.position, a.uid, b.uid))
  }

  function syncParentChildren(parentUid) {
    if (!parentUid) return
    const ordered = childRows(parentUid).map(row => row.uid)
    childIndex.set(parentUid, ordered)
    if (g[parentUid]) g[parentUid].children = ordered
  }

  function syncNode(uid) {
    const row = rows.get(uid)
    if (!row || row.deleted) {
      delete g[uid]
      return
    }
    const prev = g[uid] || { children: [] }
    g[uid] = {
      isRoot: !!row.is_root,
      data: { ...(row.data || {}), uid },
      children: Array.isArray(prev.children) ? prev.children : [],
      position: row.position || ''
    }
  }

  let meta = {}
  return {
    kind: 'memory',
    stats,
    graph: g,
    getMeta() {
      return { ...meta }
    },
    setMeta(next) {
      meta = { ...(next || {}) }
    },
    async getLive(uid) {
      touch()
      stats.reads += 1
      const row = rows.get(uid)
      if (!row || row.deleted) return null
      return { ...row, data: { ...(row.data || {}) } }
    },
    async getAny(uid) {
      touch()
      stats.reads += 1
      const row = rows.get(uid)
      return row ? { ...row, data: { ...(row.data || {}) } } : null
    },
    async resolveRoot() {
      touch()
      stats.reads += 1
      if (rootUid) {
        const cached = rows.get(rootUid)
        if (cached && cached.is_root && !cached.deleted) return rootUid
      }
      let found = 'root'
      rows.forEach(row => {
        if (row.is_root && !row.deleted) found = row.uid
      })
      rootUid = found
      return found
    },
    async insert(row) {
      touch()
      stats.writes += 1
      rows.set(row.uid, {
        uid: row.uid,
        parent_uid: row.parent_uid || null,
        position: row.position || '',
        data: { ...(row.data || {}), uid: row.uid },
        is_root: !!row.is_root,
        deleted: false,
        node_version: Number(row.node_version) || 0
      })
      if (!childIndex.has(row.uid)) childIndex.set(row.uid, [])
      const parentUid = row.parent_uid
      if (parentUid) {
        const kids = childIndex.get(parentUid) || []
        if (!kids.includes(row.uid)) kids.push(row.uid)
        childIndex.set(parentUid, kids)
      }
      syncNode(row.uid)
      syncParentChildren(parentUid)
    },
    async updateData(uid, data, version) {
      touch()
      stats.writes += 1
      const row = rows.get(uid)
      if (!row || row.deleted) return false
      row.data = { ...(data || {}), uid }
      row.node_version = version
      syncNode(uid)
      return true
    },
    async updateLocation(uid, next, version) {
      touch()
      stats.writes += 1
      const row = rows.get(uid)
      if (!row || row.deleted) return false
      const oldParent = row.parent_uid
      row.parent_uid = next.parent_uid
      row.position = next.position || row.position
      row.node_version = version
      if (oldParent !== next.parent_uid) {
        childIndex.set(
          oldParent,
          (childIndex.get(oldParent) || []).filter(id => id !== uid)
        )
        const kids = childIndex.get(next.parent_uid) || []
        if (!kids.includes(uid)) kids.push(uid)
        childIndex.set(next.parent_uid, kids)
      }
      syncNode(uid)
      if (oldParent !== next.parent_uid) syncParentChildren(oldParent)
      syncParentChildren(next.parent_uid)
      return true
    },
    async updatePositions(pairs, version) {
      touch()
      stats.writes += 1
      const parents = new Set()
      ;(pairs || []).forEach(item => {
        const row = rows.get(item.uid)
        if (!row || row.deleted) return
        row.position = item.position
        row.node_version = version
        syncNode(item.uid)
        if (row.parent_uid) parents.add(row.parent_uid)
      })
      parents.forEach(syncParentChildren)
    },
    async tombstone(uids, version) {
      touch()
      stats.writes += 1
      const parents = new Set()
      ;(uids || []).forEach(uid => {
        const row = rows.get(uid)
        if (!row) return
        row.deleted = true
        row.node_version = version
        if (row.parent_uid) {
          parents.add(row.parent_uid)
          childIndex.set(
            row.parent_uid,
            (childIndex.get(row.parent_uid) || []).filter(id => id !== uid)
          )
        }
        childIndex.delete(uid)
        delete g[uid]
      })
      parents.forEach(syncParentChildren)
    },
    async listChildren(parentUid) {
      touch()
      stats.reads += 1
      return childRows(parentUid).map(row => ({
        uid: row.uid,
        position: row.position
      }))
    },
    async walkAncestors(uid) {
      touch()
      stats.reads += 1
      const out = []
      const seen = new Set()
      let cur = uid
      while (cur && !seen.has(cur)) {
        seen.add(cur)
        const row = rows.get(cur)
        if (!row || row.deleted) break
        out.push({ uid: row.uid, data: row.data, parent_uid: row.parent_uid })
        cur = row.parent_uid
      }
      return out
    },
    async isDescendant(ancestorUid, uid) {
      touch()
      stats.reads += 1
      if (!ancestorUid || !uid || ancestorUid === uid) return false
      const stack = [ancestorUid]
      const seen = new Set()
      while (stack.length) {
        const cur = stack.pop()
        if (seen.has(cur)) continue
        seen.add(cur)
        const kids = childIndex.get(cur) || []
        for (let i = 0; i < kids.length; i++) {
          const child = kids[i]
          if (child === uid) return true
          stack.push(child)
        }
      }
      return false
    },
    async descendantUids(uid) {
      touch()
      stats.reads += 1
      const out = []
      const stack = [uid]
      const seen = new Set()
      while (stack.length) {
        const cur = stack.pop()
        if (seen.has(cur)) continue
        seen.add(cur)
        if (cur !== uid) out.push(cur)
        const kids = childIndex.get(cur) || []
        kids.forEach(child => stack.push(child))
      }
      return out
    },
    async getMany(uids) {
      touch()
      stats.reads += 1
      return (uids || [])
        .map(uid => rows.get(uid))
        .filter(Boolean)
        .map(row => ({ ...row, data: { ...(row.data || {}) } }))
    },
    async insertMany(list) {
      for (let i = 0; i < (list || []).length; i++) {
        await this.insert(list[i])
      }
    },
    async revive(list, version) {
      touch()
      stats.writes += 1
      const parents = new Set()
      ;(list || []).forEach(item => {
        const prev = rows.get(item.uid) || {}
        rows.set(item.uid, {
          uid: item.uid,
          parent_uid: item.parent_uid != null ? item.parent_uid : prev.parent_uid,
          position: item.position || prev.position || '',
          data: { ...(item.data || prev.data || {}), uid: item.uid },
          is_root: !!item.is_root || !!prev.is_root,
          deleted: false,
          node_version: version
        })
        if (!childIndex.has(item.uid)) childIndex.set(item.uid, [])
        const parentUid = rows.get(item.uid).parent_uid
        if (parentUid) {
          const kids = childIndex.get(parentUid) || []
          if (!kids.includes(item.uid)) kids.push(item.uid)
          childIndex.set(parentUid, kids)
          parents.add(parentUid)
        }
        syncNode(item.uid)
      })
      parents.forEach(syncParentChildren)
    },
    resetStats() {
      stats.queries = 0
      stats.reads = 0
      stats.writes = 0
      if (Array.isArray(stats.sql)) stats.sql.length = 0
    }
  }
}

function createPgStore(client, roomKey) {
  const stats = { queries: 0, reads: 0, writes: 0, sql: [] }
  const childCache = new Map()

  async function query(sql, params) {
    stats.queries += 1
    stats.sql.push(sql.replace(/\s+/g, ' ').trim().slice(0, 160))
    return client.query(sql, params)
  }

  function rowFrom(dbRow) {
    if (!dbRow) return null
    return {
      uid: dbRow.uid,
      parent_uid: dbRow.parent_uid,
      position: dbRow.position || '',
      data: dbRow.data || {},
      is_root: !!dbRow.is_root,
      deleted: !!dbRow.deleted_at,
      node_version: Number(dbRow.node_version || 0)
    }
  }

  function invalidate(parentUid) {
    if (parentUid) childCache.delete(parentUid)
  }

  let meta = {}
  return {
    kind: 'pg',
    stats,
    getMeta() {
      return { ...meta }
    },
    setMeta(next) {
      meta = { ...(next || {}) }
    },
    async getLive(uid) {
      stats.reads += 1
      const res = await query(
        `select uid, parent_uid, position, data, is_root, node_version, deleted_at
         from room_nodes
         where room_key = $1 and uid = $2 and deleted_at is null`,
        [roomKey, uid]
      )
      return rowFrom(res.rows[0])
    },
    async getAny(uid) {
      stats.reads += 1
      const res = await query(
        `select uid, parent_uid, position, data, is_root, node_version, deleted_at
         from room_nodes
         where room_key = $1 and uid = $2`,
        [roomKey, uid]
      )
      return rowFrom(res.rows[0])
    },
    async resolveRoot() {
      stats.reads += 1
      const res = await query(
        `select uid from room_nodes
         where room_key = $1 and is_root and deleted_at is null
         limit 1`,
        [roomKey]
      )
      return (res.rows[0] && res.rows[0].uid) || 'root'
    },
    async insert(row) {
      stats.writes += 1
      await query(
        `insert into room_nodes
           (room_key, uid, parent_uid, position, data, is_root, node_version, deleted_at, updated_at)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, null, now())`,
        [
          roomKey,
          row.uid,
          row.parent_uid || null,
          row.position || '',
          JSON.stringify({ ...(row.data || {}), uid: row.uid }),
          !!row.is_root,
          Number(row.node_version) || 0
        ]
      )
      invalidate(row.parent_uid)
    },
    async updateData(uid, data, version) {
      stats.writes += 1
      const res = await query(
        `update room_nodes
         set data = $3::jsonb, node_version = $4, updated_at = now()
         where room_key = $1 and uid = $2 and deleted_at is null`,
        [roomKey, uid, JSON.stringify({ ...(data || {}), uid }), version]
      )
      return res.rowCount > 0
    },
    async updateLocation(uid, next, version) {
      stats.writes += 1
      const prev = await this.getLive(uid)
      const res = await query(
        `update room_nodes
         set parent_uid = $3, position = $4, node_version = $5, updated_at = now()
         where room_key = $1 and uid = $2 and deleted_at is null`,
        [roomKey, uid, next.parent_uid || null, next.position || '', version]
      )
      if (prev) invalidate(prev.parent_uid)
      invalidate(next.parent_uid)
      return res.rowCount > 0
    },
    async updatePositions(pairs, version) {
      if (!pairs || !pairs.length) return
      stats.writes += 1
      const uids = pairs.map(item => item.uid)
      const positions = pairs.map(item => item.position)
      await query(
        `update room_nodes as n
         set position = v.position, node_version = $3, updated_at = now()
         from unnest($2::text[], $4::text[]) as v(uid, position)
         where n.room_key = $1 and n.uid = v.uid and n.deleted_at is null`,
        [roomKey, uids, version, positions]
      )
      childCache.clear()
    },
    async tombstone(uids, version) {
      if (!uids || !uids.length) return
      stats.writes += 1
      await query(
        `update room_nodes
         set deleted_at = now(), node_version = $3, updated_at = now()
         where room_key = $1 and uid = any($2::text[]) and deleted_at is null`,
        [roomKey, uids, version]
      )
      childCache.clear()
    },
    async listChildren(parentUid) {
      stats.reads += 1
      if (childCache.has(parentUid)) return childCache.get(parentUid).slice()
      const res = await query(
        `select uid, position
         from room_nodes
         where room_key = $1 and parent_uid = $2 and deleted_at is null
         order by position, uid`,
        [roomKey, parentUid]
      )
      const rows = res.rows.map(row => ({ uid: row.uid, position: row.position || '' }))
      childCache.set(parentUid, rows)
      return rows.slice()
    },
    async walkAncestors(uid) {
      stats.reads += 1
      const res = await query(
        `with recursive walk as (
           select uid, parent_uid, data, 0 as depth
           from room_nodes
           where room_key = $1 and uid = $2 and deleted_at is null
           union all
           select n.uid, n.parent_uid, n.data, w.depth + 1
           from room_nodes n
           inner join walk w on n.room_key = $1 and n.uid = w.parent_uid and n.deleted_at is null
           where w.depth < 64
         )
         select uid, parent_uid, data from walk`,
        [roomKey, uid]
      )
      return res.rows.map(row => ({
        uid: row.uid,
        parent_uid: row.parent_uid,
        data: row.data || {}
      }))
    },
    async isDescendant(ancestorUid, uid) {
      stats.reads += 1
      if (!ancestorUid || !uid || ancestorUid === uid) return false
      const res = await query(
        `with recursive walk as (
           select uid, 0 as depth
           from room_nodes
           where room_key = $1 and parent_uid = $2 and deleted_at is null
           union all
           select n.uid, w.depth + 1
           from room_nodes n
           inner join walk w on n.room_key = $1 and n.parent_uid = w.uid and n.deleted_at is null
           where w.depth < 64
         )
         select 1 from walk where uid = $3 limit 1`,
        [roomKey, ancestorUid, uid]
      )
      return res.rows.length > 0
    },
    async descendantUids(uid) {
      stats.reads += 1
      const res = await query(
        `with recursive walk as (
           select uid, 0 as depth
           from room_nodes
           where room_key = $1 and parent_uid = $2 and deleted_at is null
           union all
           select n.uid, w.depth + 1
           from room_nodes n
           inner join walk w on n.room_key = $1 and n.parent_uid = w.uid and n.deleted_at is null
           where w.depth < 64
         )
         select uid from walk`,
        [roomKey, uid]
      )
      return res.rows.map(row => row.uid)
    },
    async getMany(uids) {
      stats.reads += 1
      if (!uids || !uids.length) return []
      const res = await query(
        `select uid, parent_uid, position, data, is_root, node_version, deleted_at
         from room_nodes
         where room_key = $1 and uid = any($2::text[])`,
        [roomKey, uids]
      )
      return res.rows.map(rowFrom)
    },
    async insertMany(list) {
      if (!list || !list.length) return
      stats.writes += 1
      const version = Number(list[0].node_version) || 0
      await query(
        `insert into room_nodes
           (room_key, uid, parent_uid, position, data, is_root, node_version, deleted_at, updated_at)
         select $1, x.uid, x.parent_uid, x.position, x.data, x.is_root, $2, null, now()
         from jsonb_to_recordset($3::jsonb)
           as x(uid text, parent_uid text, position text, data jsonb, is_root boolean)`,
        [
          roomKey,
          version,
          JSON.stringify(
            list.map(row => ({
              uid: row.uid,
              parent_uid: row.parent_uid || null,
              position: row.position || '',
              data: { ...(row.data || {}), uid: row.uid },
              is_root: !!row.is_root
            }))
          )
        ]
      )
      childCache.clear()
    },
    async revive(list, version) {
      if (!list || !list.length) return
      stats.writes += 1
      await query(
        `insert into room_nodes
           (room_key, uid, parent_uid, position, data, is_root, node_version, deleted_at, updated_at)
         select $1, x.uid, x.parent_uid, x.position, x.data, x.is_root, $2, null, now()
         from jsonb_to_recordset($3::jsonb)
           as x(uid text, parent_uid text, position text, data jsonb, is_root boolean)
         on conflict (room_key, uid) do update set
           parent_uid = excluded.parent_uid,
           position = excluded.position,
           data = excluded.data,
           is_root = excluded.is_root,
           node_version = excluded.node_version,
           deleted_at = null,
           updated_at = now()`,
        [
          roomKey,
          version,
          JSON.stringify(
            list.map(row => ({
              uid: row.uid,
              parent_uid: row.parent_uid || null,
              position: row.position || '',
              data: { ...(row.data || {}), uid: row.uid },
              is_root: !!row.is_root
            }))
          )
        ]
      )
      childCache.clear()
    },
    resetStats() {
      stats.queries = 0
      stats.reads = 0
      stats.writes = 0
      stats.sql.length = 0
    }
  }
}

module.exports = {
  createMemoryStore,
  createPgStore,
  isSopLabel,
  stripHtml
}
