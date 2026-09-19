const path = require('path')
const store = require('../manifestStore')
const { readCanonical } = require('./canonicalInput')
const client = require('./docmostClient')

const ROLE_MAP = {
  owner: 'admin',
  editor: 'writer',
  viewer: 'reader'
}

function syncEnabled(env = process.env) {
  return client.cfg(env).enabled
}

async function health(baseUrl) {
  const url = baseUrl || client.cfg().baseUrl
  const response = await fetch(new URL('/api/health', url), {
    signal: AbortSignal.timeout(10000)
  })
  return {
    adapter: 'docmost',
    reachable: response.ok,
    httpStatus: response.status,
    syncImplemented: true,
    syncEnabled: syncEnabled()
  }
}

function mapRole(role) {
  return ROLE_MAP[String(role || '').toLowerCase()] || 'reader'
}

function titleFromMarkdown(text, fallback) {
  const match = String(text || '').match(/^#\s+(.+)$/m)
  const heading = match && match[1] ? match[1].trim() : ''
  return (heading || fallback || '未命名').slice(0, 200)
}

/**
 * Public mind-map origin for links that must work from Docmost (different host/port).
 * Prefer AUTH_APP_ORIGIN so Wiki attachment links hit the real 良策入口, not Docmost.
 */
function mindMapPublicBase(env = process.env) {
  const origin = String(
    env.AUTH_APP_ORIGIN || env.MIND_MAP_PUBLIC_URL || ''
  )
    .trim()
    .replace(/\/$/, '')
  if (origin && /^https?:\/\//i.test(origin)) return origin
  const host = String(env.PUBLIC_HOST || '127.0.0.1').trim() || '127.0.0.1'
  const port = Number(env.WEB_PORT || env.MIND_MAP_PORT || 8989) || 8989
  return `http://${host}:${port}`
}

/**
 * Docmost resolves /p/:pageSlug via extractPageSlugId (last "-" segment = slugId).
 * UUID page ids break clicks and export link rewrite — always use slugId.
 */
function buildDocmostPagePath(spaceSlug, slugId, title) {
  const id = String(slugId || '').trim()
  if (!id) return null
  const titleSlug =
    String(title || 'untitled')
      .slice(0, 70)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  const pageSlug = `${titleSlug}-${id}`
  const space = String(spaceSlug || '').trim()
  return space ? `/s/${space}/p/${pageSlug}` : `/p/${pageSlug}`
}

/**
 * Canonical knowledge MD keeps machine metadata (YAML frontmatter, node anchors,
 * hash comments, relative .md branch links). Docmost should receive clean Markdown.
 */
function toDocmostMarkdown(text, { pageLinks = null, env = process.env } = {}) {
  let body = String(text || '').replace(/\r\n?/g, '\n')
  // Drop YAML frontmatter
  body = body.replace(/^---\n[\s\S]*?\n---\n+/, '')
  // Drop compiler anchors / hash comments
  body = body.replace(/<a\s+id="node-[^"]*"\s*><\/a>\n?/gi, '')
  body = body.replace(/<!--\s*mindmap:node=[^>]*-->\n?/gi, '')
  // Rewrite relative branch links → Docmost page path or plain title
  body = body.replace(
    /\[([^\]]+)\]\((branches\/[a-zA-Z0-9._-]+\.md)\)/g,
    (_, label, file) => {
      const key = file
      const link = pageLinks && pageLinks.get(key)
      if (link) return `[${label}](${link})`
      return label
    }
  )
  // Attachment / file APIs are served by mind-map, not Docmost — make absolute
  const appBase = mindMapPublicBase(env)
  body = body.replace(
    /\]\((\/api\/(?:files|maps|rooms)\/[^)\s]+)\)/g,
    `](${appBase}$1)`
  )
  // Collapse excess blank lines left by stripped markers
  body = body.replace(/\n{3,}/g, '\n\n').trim()
  return body ? `${body}\n` : ''
}

function roomMetaQuery() {
  return `select r.room_key, r.title, r.owner_id, r.team_id,
            coalesce(t.name, '') as team_name,
            coalesce(u.name, r.owner_id, '') as owner_name
         from rooms r
         left join teams t on t.id = r.team_id
         left join wecom_users u on u.user_id = r.owner_id
        where r.room_key = $1 and r.deleted_at is null`
}

async function loadRoomMeta(pool, roomId) {
  try {
    const row = (await pool.query(roomMetaQuery(), [roomId])).rows[0]
    return row || null
  } catch (err) {
    if (err.code !== '42P01') throw err
    const row = (
      await pool.query(
        `select room_key, title, owner_id, team_id, '' as team_name, owner_id as owner_name
           from rooms where room_key = $1 and deleted_at is null`,
        [roomId]
      )
    ).rows[0]
    return row || null
  }
}

async function loadRoomMembers(pool, roomId) {
  const roomAcl = require('../../roomAcl')
  try {
    return await roomAcl.listMembers(pool, roomId)
  } catch (err) {
    return []
  }
}

async function ensureSpace(auth, room, env) {
  const db = client.getPool(env)
  const isTeam = !!(room.team_id && String(room.team_id).trim())
  const ownerKey = String(room.owner_id || '').trim() || String(room.room_key || 'personal')
  const slug = isTeam
    ? client.sanitizeSlug(room.team_id, 'team')
    : client.sanitizeSlug(ownerKey, 'personal')
  const name = isTeam
    ? String(room.team_name || room.team_id || '团队空间').slice(0, 100)
    : `个人 · ${String(room.owner_name || room.owner_id || room.room_key || '未命名').slice(0, 80)}`

  let space = await client.findSpaceBySlug(db, auth.workspaceId, slug)
  if (!space) {
    try {
      const created = await client.request(
        '/api/spaces/create',
        {
          cookie: auth.cookie,
          body: {
            name: name.length >= 2 ? name : `${name}-空间`,
            description: isTeam
              ? `良策团队「${name}」知识库`
              : `良策个人知识库`,
            slug
          },
          env
        }
      )
      space = {
        id: created.id || created.spaceId || (created.data && created.data.id),
        name: created.name || name,
        slug: created.slug || slug
      }
    } catch (err) {
      // Race: another worker created it
      space = await client.findSpaceBySlug(db, auth.workspaceId, slug)
      if (!space) throw err
    }
  } else if (space.name !== name && name.length >= 2) {
    try {
      await client.request('/api/spaces/update', {
        cookie: auth.cookie,
        body: { spaceId: space.id, name },
        env
      })
      space.name = name
    } catch (_) {
      /* rename is best-effort */
    }
  }
  return {
    spaceId: space.id,
    slug: space.slug || slug,
    name: space.name || name,
    kind: isTeam ? 'team' : 'personal'
  }
}

async function syncMembers(auth, spaceId, members, env) {
  const db = client.getPool(env)
  const desired = new Map()
  for (const member of members || []) {
    const userId = String(member.user_id || member.wecom_userid || '').trim()
    if (!userId) continue
    const role = mapRole(member.role)
    const prev = desired.get(userId)
    const rank = { admin: 3, writer: 2, reader: 1 }
    if (!prev || rank[role] > rank[prev.role]) {
      desired.set(userId, {
        userId,
        name: member.name || userId,
        role
      })
    }
  }

  const existing = (
    await db.query(
      `select sm.user_id, sm.role
         from space_members sm
        where sm.space_id = $1
          and sm.user_id is not null
          and sm.deleted_at is null`,
      [spaceId]
    )
  ).rows
  const existingByUser = new Map(
    existing.map(row => [row.user_id, String(row.role || '')])
  )

  // Always keep sync actor as admin
  if (!existingByUser.has(auth.userId)) {
    try {
      await client.request('/api/spaces/members/add', {
        cookie: auth.cookie,
        body: {
          spaceId,
          role: 'admin',
          userIds: [auth.userId],
          groupIds: []
        },
        env
      })
    } catch (_) {
      /* may already be creator */
    }
  }

  for (const item of desired.values()) {
    const docUser = await client.ensureUser(db, auth.workspaceId, {
      userId: item.userId,
      name: item.name
    })
    const current = existingByUser.get(docUser.id)
    if (!current) {
      await client.request('/api/spaces/members/add', {
        cookie: auth.cookie,
        body: {
          spaceId,
          role: item.role,
          userIds: [docUser.id],
          groupIds: []
        },
        env
      })
      existingByUser.set(docUser.id, item.role)
    } else if (current !== item.role && docUser.id !== auth.userId) {
      try {
        await client.request('/api/spaces/members/change-role', {
          cookie: auth.cookie,
          body: {
            spaceId,
            userId: docUser.id,
            role: item.role
          },
          env
        })
        existingByUser.set(docUser.id, item.role)
      } catch (_) {
        /* ignore role change failures */
      }
    }
  }
}

async function resolveSlugId(env, pageId, fromApi) {
  const fromRes =
    (fromApi && (fromApi.slugId || fromApi.slug_id)) ||
    null
  if (fromRes) return String(fromRes)
  const db = client.getPool(env)
  return (await client.findPageSlugId(db, pageId)) || null
}

async function upsertPage(auth, { spaceId, pageId, parentPageId, title, markdown, env }) {
  if (pageId) {
    try {
      const updated = await client.request('/api/pages/update', {
        cookie: auth.cookie,
        body: {
          pageId,
          title,
          content: markdown,
          format: 'markdown',
          operation: 'replace'
        },
        env
      })
      const slugId = await resolveSlugId(env, pageId, updated)
      return { pageId, slugId }
    } catch (err) {
      // Stale mapping: recreate under current space
      if (err.status !== 404 && !/not found/i.test(String(err.message || ''))) throw err
      pageId = null
    }
  }
  try {
    const created = await client.request('/api/pages/create', {
      cookie: auth.cookie,
      body: {
        spaceId,
        title,
        parentPageId: parentPageId || undefined,
        content: markdown,
        format: 'markdown'
      },
      env
    })
    const id = created && created.id
    if (!id) return { pageId: null, slugId: null }
    const slugId = await resolveSlugId(env, id, created)
    return { pageId: id, slugId }
  } catch (err) {
    // Parent missing/stale: fall back to space root
    if (parentPageId && /parent page not found/i.test(String(err.message || ''))) {
      const created = await client.request('/api/pages/create', {
        cookie: auth.cookie,
        body: {
          spaceId,
          title,
          content: markdown,
          format: 'markdown'
        },
        env
      })
      const id = created && created.id
      if (!id) return { pageId: null, slugId: null }
      const slugId = await resolveSlugId(env, id, created)
      return { pageId: id, slugId }
    }
    throw err
  }
}

async function deletePage(auth, pageId, env) {
  if (!pageId) return
  try {
    await client.request('/api/pages/delete', {
      cookie: auth.cookie,
      body: { pageId },
      env
    })
  } catch (_) {
    /* page may already be gone */
  }
}

async function writeDownstream(outputDir, roomId, downstream) {
  const roomDir = path.join(path.resolve(outputDir), roomId)
  await store.recover(roomDir)
  const manifest = await store.readManifest(roomDir)
  if (!manifest) return null
  const next = {
    ...manifest,
    downstream: {
      ...(manifest.downstream || {}),
      docmost: downstream
    }
  }
  await store.atomicWrite(
    path.join(roomDir, 'manifest.json'),
    JSON.stringify(next, null, 2) + '\n'
  )
  return next
}

/**
 * Push one room's canonical Markdown into Docmost (personal/team space + ACL).
 */
async function sync(roomId, options = {}) {
  const env = options.env || process.env
  if (!syncEnabled(env)) {
    return { roomId, skipped: true, reason: 'DOCMOST_SYNC_ENABLED off' }
  }
  const mindPool = options.pool
  if (!mindPool) throw new Error('docmost sync requires mind-map pool')
  const outputDir =
    options.outputDir ||
    process.env.KNOWLEDGE_OUTPUT_DIR ||
    path.resolve(__dirname, '../../../../knowledge')

  const room = await loadRoomMeta(mindPool, roomId)
  if (!room) return { roomId, skipped: true, reason: 'room missing' }

  const auth = await client.ensureSyncAuth(env)
  const space = await ensureSpace(auth, room, env)
  const members = await loadRoomMembers(mindPool, roomId)
  await syncMembers(auth, space.spaceId, members, env)

  let canonical
  try {
    canonical = await readCanonical(outputDir, roomId)
  } catch (err) {
    return { roomId, skipped: true, reason: err.message }
  }

  const previousRaw =
    (canonical.manifest.downstream && canonical.manifest.downstream.docmost) ||
    {}
  // Space changed (e.g. personal slug fix): drop stale pageIds from other spaces
  const previous =
    previousRaw.spaceId && previousRaw.spaceId !== space.spaceId
      ? {}
      : previousRaw
  const pages = { ...(previous.pages || {}) }
  const docsByFile = new Map(
    canonical.documents.map(doc => [doc.file, doc])
  )

  const sameVersion =
    previous.lastPushedVersion === canonical.manifest.lastCompiledVersion &&
    previous.spaceId &&
    Object.keys(previous.pages || {}).length === canonical.documents.length &&
    canonical.documents.every(doc => {
      const prev = previous.pages && previous.pages[doc.file]
      return prev && prev.pageId && prev.contentHash === doc.fileHash
    })
  // Old pushes stored /p/{uuid} links — refresh when any branch lacks slugId
  const needsLinkRewrite = Object.entries(previous.pages || {}).some(
    ([file, meta]) => file !== 'README.md' && meta && meta.pageId && !meta.slugId
  )
  if (sameVersion && !options.force && !needsLinkRewrite) {
    // Content unchanged; still refresh ACL on demand
    if (options.syncMembers !== false) {
      const members = await loadRoomMembers(mindPool, roomId)
      await syncMembers(auth, previous.spaceId, members, env)
    }
    return {
      roomId,
      status: 'synced',
      skippedContent: true,
      spaceId: previous.spaceId,
      spaceKind: previous.spaceKind,
      pages: Object.keys(previous.pages || {}).length
    }
  }

  const branchDocs = canonical.documents.filter(doc => doc.file !== 'README.md')
  const force = !!options.force
  const db = client.getPool(env)

  // Root page first (clean Markdown; branch links filled in a second pass)
  const readme = docsByFile.get('README.md')
  if (readme) {
    const title = String(
      room.title && room.title !== '未命名'
        ? room.title
        : titleFromMarkdown(readme.text, roomId)
    ).slice(0, 200)
    const prev = pages['README.md'] || {}
    if (force || !prev.pageId || prev.contentHash !== readme.fileHash || prev.title !== title) {
      const upserted = await upsertPage(auth, {
        spaceId: space.spaceId,
        pageId: prev.pageId,
        title,
        markdown: toDocmostMarkdown(readme.text, { env }),
        env
      })
      pages['README.md'] = {
        pageId: upserted.pageId,
        slugId: upserted.slugId || prev.slugId || null,
        contentHash: readme.fileHash,
        title,
        parentPageId: null
      }
    } else if (prev.pageId && !prev.slugId) {
      pages['README.md'] = {
        ...prev,
        slugId: await client.findPageSlugId(db, prev.pageId)
      }
    }
  }

  const rootPageId = pages['README.md'] && pages['README.md'].pageId

  // Branch pages under root — upload cleaned Markdown only
  for (const doc of branchDocs) {
    const title = titleFromMarkdown(
      doc.text,
      doc.file.replace(/^branches\//, '').replace(/\.md$/, '')
    )
    const prev = pages[doc.file] || {}
    if (
      !force &&
      prev.pageId &&
      prev.contentHash === doc.fileHash &&
      prev.title === title &&
      prev.parentPageId === rootPageId
    ) {
      if (!prev.slugId && prev.pageId) {
        pages[doc.file] = {
          ...prev,
          slugId: await client.findPageSlugId(db, prev.pageId)
        }
      }
      continue
    }
    // Stale page under wrong parent: recreate so hierarchy is correct
    const recreate =
      prev.pageId && rootPageId && prev.parentPageId && prev.parentPageId !== rootPageId
    if (recreate) {
      await deletePage(auth, prev.pageId, env)
      prev.pageId = null
      prev.slugId = null
    }
    const upserted = await upsertPage(auth, {
      spaceId: space.spaceId,
      pageId: prev.pageId,
      parentPageId: rootPageId || undefined,
      title,
      markdown: toDocmostMarkdown(doc.text, { env }),
      env
    })
    pages[doc.file] = {
      pageId: upserted.pageId,
      slugId: upserted.slugId || prev.slugId || null,
      contentHash: doc.fileHash,
      title,
      parentPageId: rootPageId || null
    }
  }

  // Second pass: rewrite README links to Docmost slug paths (not UUIDs)
  if (readme && pages['README.md'] && pages['README.md'].pageId) {
    const pageLinks = new Map()
    for (const [file, meta] of Object.entries(pages)) {
      if (file === 'README.md' || !meta || !meta.pageId) continue
      let slugId = meta.slugId
      if (!slugId) {
        slugId = await client.findPageSlugId(db, meta.pageId)
        if (slugId) pages[file] = { ...meta, slugId }
      }
      const href = buildDocmostPagePath(space.slug, slugId, meta.title)
      if (href) pageLinks.set(file, href)
    }
    await upsertPage(auth, {
      spaceId: space.spaceId,
      pageId: pages['README.md'].pageId,
      title: pages['README.md'].title,
      markdown: toDocmostMarkdown(readme.text, { pageLinks, env }),
      env
    })
  }

  // Delete pages for removed files
  for (const file of Object.keys(pages)) {
    if (docsByFile.has(file)) continue
    await deletePage(auth, pages[file].pageId, env)
    delete pages[file]
  }

  const downstream = {
    spaceId: space.spaceId,
    spaceSlug: space.slug,
    spaceKind: space.kind,
    rootPageId: pages['README.md'] ? pages['README.md'].pageId : null,
    pages,
    lastPushedVersion: canonical.manifest.lastCompiledVersion,
    lastPushedSourceRevision: canonical.manifest.lastSourceRevision,
    lastPushedAt: new Date().toISOString()
  }
  await writeDownstream(outputDir, roomId, downstream)

  return {
    roomId,
    status: 'synced',
    spaceId: space.spaceId,
    spaceKind: space.kind,
    pages: Object.keys(pages).length
  }
}

module.exports = {
  health,
  sync,
  syncEnabled,
  readCanonical,
  mapRole,
  toDocmostMarkdown,
  mindMapPublicBase,
  buildDocmostPagePath,
  __test: {
    titleFromMarkdown,
    ensureSpace,
    toDocmostMarkdown,
    mindMapPublicBase,
    buildDocmostPagePath
  }
}
