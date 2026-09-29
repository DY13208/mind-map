const path = require('path')
const store = require('../manifestStore')
const { readCanonical } = require('./canonicalInput')
const client = require('./docmostClient')
const mappingStore = require('../docmostMappingStore')

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
 *
 * Human-slot reverse sync needs stable node markers in Wiki Markdown. Pass
 * `{ preserveMindmapMarkers: true }` to keep `<!-- mindmap:node=... -->` and
 * inline-code `` `mindmap:node=...` `` markers (Docmost strips HTML comments).
 */
function toDocmostMarkdown(
  text,
  { pageLinks = null, env = process.env, preserveMindmapMarkers = false } = {}
) {
  let body = String(text || '').replace(/\r\n?/g, '\n')
  // Drop YAML frontmatter
  body = body.replace(/^---\n[\s\S]*?\n---\n+/, '')
  if (!preserveMindmapMarkers) {
    // Drop compiler anchors / hash comments (standard slot: clean Wiki view)
    body = body.replace(/<a\s+id="node-[^"]*"\s*><\/a>\n?/gi, '')
    body = body.replace(/<!--\s*mindmap:node=[^>]*-->\n?/gi, '')
    body = body.replace(/^`mindmap:node=[^`]+`\s*$/gim, '')
    body = body.replace(/^mindmap-node:[0-9a-fA-F]+(?:\s+hash=\S+)?\s*$/gim, '')
  } else {
    // Keep markers; still drop empty anchors (Docmost may strip them)
    body = body.replace(/<a\s+id="node-[^"]*"\s*><\/a>\n?/gi, '')
  }
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

  await mappingStore.ensureSchema(mindPool)

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
  const previous =
    previousRaw.spaceId && previousRaw.spaceId !== space.spaceId
      ? {}
      : previousRaw

  const force = !!options.force
  const db = client.getPool(env)
  const warnings = []
  const pages = {}
  const versionTag = String(
    canonical.manifest.lastCompiledVersion ||
      canonical.manifest.lastSourceRevision ||
      ''
  )

  async function syncStandardDoc(doc, { parentPageId, titleBase, pageLinks }) {
    const topicKey = mappingStore.topicKeyFromCanonicalPath(doc.file)
    const title = mappingStore.standardTitle(titleBase)
    let standard = await mappingStore.getMapping(mindPool, {
      roomId,
      topicKey,
      slot: 'standard'
    })

    const legacyPageId =
      previous.pages &&
      previous.pages[doc.file] &&
      previous.pages[doc.file].pageId

    // Legacy migration: keep old mixed page as human; never replace it with Canonical
    if (!standard && legacyPageId) {
      const human = await mappingStore.getMapping(mindPool, {
        roomId,
        topicKey,
        slot: 'human'
      })
      if (!human) {
        await mappingStore.upsertMapping(mindPool, {
          roomId,
          topicKey,
          slot: 'human',
          owner: 'human',
          canonicalPath: doc.file,
          docmostSpaceId: space.spaceId,
          docmostPageId: legacyPageId,
          contentHash:
            (previous.pages[doc.file] && previous.pages[doc.file].contentHash) ||
            '',
          lastSyncedVersion: '',
          title:
            (previous.pages[doc.file] && previous.pages[doc.file].title) ||
            titleBase
        })
        warnings.push({
          code: 'LEGACY_PAGE_PRESERVED_AS_HUMAN',
          topicKey,
          pageId: legacyPageId
        })
        console.warn(
          '[DocmostSync][room=' +
            roomId +
            '] legacy page preserved as human slot: topic=' +
            topicKey +
            ' page=' +
            legacyPageId
        )
      }
      standard = null
    }

    const marker = mappingStore.ownershipMarker({
      roomId,
      topicKey,
      slot: 'standard',
      owner: 'mindmap'
    })
    const body = toDocmostMarkdown(doc.text, { pageLinks, env })
    const markdown = marker + body
    const contentHash = String(doc.fileHash || '')

    if (standard) {
      const guard = mappingStore.assertReplaceAllowed(standard, {
        topicKey,
        expectedPageId: standard.docmost_page_id
      })
      if (!guard.ok) {
        warnings.push({
          code: 'OWNERSHIP_GUARD_BLOCKED_REPLACE',
          topicKey,
          reason: guard.reason,
          mappingPageId: standard.docmost_page_id
        })
        console.error(
          '[DocmostSync][room=' +
            roomId +
            '] ownership guard blocked replace: topic=' +
            topicKey +
            ' reason=' +
            guard.reason +
            ' — creating a new standard page instead'
        )
        standard = null
      } else if (
        !force &&
        // The second pass must refresh links even when canonical text is unchanged.
        !pageLinks &&
        standard.content_hash === contentHash &&
        standard.title === title &&
        standard.docmost_space_id === space.spaceId
      ) {
        // Content unchanged ≠ version synced. Bump mapping version only (no Docmost API).
        if (
          String(standard.last_synced_version || '') !== String(versionTag)
        ) {
          const bumped = await mappingStore.bumpLastSyncedVersion(mindPool, {
            roomId,
            topicKey,
            slot: 'standard',
            lastSyncedVersion: versionTag
          })
          if (bumped) standard = bumped
        }
        pages[doc.file] = {
          pageId: standard.docmost_page_id,
          slugId: await client.findPageSlugId(db, standard.docmost_page_id),
          contentHash: standard.content_hash,
          title: standard.title,
          parentPageId: parentPageId || null,
          slot: 'standard',
          owner: 'mindmap',
          topicKey
        }
        return standard.docmost_page_id
      }
    }

    if (standard && standard.docmost_page_id) {
      const { pageId, slugId } = await upsertPage(auth, {
        spaceId: space.spaceId,
        pageId: standard.docmost_page_id,
        parentPageId: parentPageId || undefined,
        title,
        markdown,
        env
      })
      const row = await mappingStore.upsertMapping(mindPool, {
        roomId,
        topicKey,
        slot: 'standard',
        owner: 'mindmap',
        canonicalPath: doc.file,
        docmostSpaceId: space.spaceId,
        docmostPageId: pageId,
        contentHash,
        lastSyncedVersion: versionTag,
        title
      })
      pages[doc.file] = {
        pageId: row.docmost_page_id,
        slugId,
        contentHash: row.content_hash,
        title: row.title,
        parentPageId: parentPageId || null,
        slot: 'standard',
        owner: 'mindmap',
        topicKey
      }
      return pageId
    }

    // Create brand-new standard page (never reuse human/ai/legacy page ids)
    const { pageId, slugId } = await upsertPage(auth, {
      spaceId: space.spaceId,
      pageId: null,
      parentPageId: parentPageId || undefined,
      title,
      markdown,
      env
    })
    const row = await mappingStore.upsertMapping(mindPool, {
      roomId,
      topicKey,
      slot: 'standard',
      owner: 'mindmap',
      canonicalPath: doc.file,
      docmostSpaceId: space.spaceId,
      docmostPageId: pageId,
      contentHash,
      lastSyncedVersion: versionTag,
      title
    })
    pages[doc.file] = {
      pageId: row.docmost_page_id,
      slugId,
      contentHash: row.content_hash,
      title: row.title,
      parentPageId: parentPageId || null,
      slot: 'standard',
      owner: 'mindmap',
      topicKey
    }
    return pageId
  }

  const docsByFile = new Map(canonical.documents.map(doc => [doc.file, doc]))
  const branchDocs = canonical.documents.filter(doc => doc.file !== 'README.md')
  const readme = docsByFile.get('README.md')
  let rootPageId = null

  if (readme) {
    const titleBase =
      room.title && room.title !== '未命名'
        ? room.title
        : titleFromMarkdown(readme.text, roomId)
    rootPageId = await syncStandardDoc(readme, {
      parentPageId: null,
      titleBase,
      pageLinks: null
    })
  }

  for (const doc of branchDocs) {
    const titleBase = titleFromMarkdown(
      doc.text,
      doc.file.replace(/^branches\//, '').replace(/\.md$/, '')
    )
    await syncStandardDoc(doc, {
      parentPageId: rootPageId || undefined,
      titleBase,
      pageLinks: null
    })
  }

  // Second pass: rewrite README branch links to Docmost standard page paths
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
    const titleBase =
      room.title && room.title !== '未命名'
        ? room.title
        : titleFromMarkdown(readme.text, roomId)
    await syncStandardDoc(readme, {
      parentPageId: null,
      titleBase,
      pageLinks
    })
  }

  // Removed canonical docs: archive STANDARD only; keep human/ai pages
  const mapped = await mappingStore.listRoomMappings(mindPool, roomId)
  for (const row of mapped) {
    if (row.slot !== 'standard') continue
    const stillThere = canonical.documents.some(
      doc =>
        mappingStore.topicKeyFromCanonicalPath(doc.file) === row.topic_key
    )
    if (stillThere) continue
    warnings.push({
      code: 'STANDARD_ARCHIVED_CANONICAL_REMOVED',
      topicKey: row.topic_key,
      pageId: row.docmost_page_id
    })
    console.warn(
      '[DocmostSync][room=' +
        roomId +
        '] archiving standard page (canonical removed): topic=' +
        row.topic_key
    )
    await deletePage(auth, row.docmost_page_id, env)
    await mappingStore.softDeleteStandardByTopic(mindPool, {
      roomId,
      topicKey: row.topic_key
    })
  }

  const downstream = {
    spaceId: space.spaceId,
    spaceSlug: space.slug,
    spaceKind: space.kind,
    rootPageId: pages['README.md'] ? pages['README.md'].pageId : null,
    pages,
    ownershipVersion: 1,
    lastPushedVersion: canonical.manifest.lastCompiledVersion,
    lastPushedSourceRevision: canonical.manifest.lastSourceRevision,
    lastPushedAt: new Date().toISOString(),
    warnings
  }
  await writeDownstream(outputDir, roomId, downstream)

  return {
    roomId,
    status: 'synced',
    spaceId: space.spaceId,
    spaceKind: space.kind,
    pages: Object.keys(pages).length,
    syncedVersion: versionTag,
    warnings
  }
}

module.exports = {
  mappingStore,
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
