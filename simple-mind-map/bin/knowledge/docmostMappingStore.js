/**
 * Mind Map owned Docmost page-ownership mapping store (PostgreSQL).
 * Source of truth for Phase 1 ownership — NOT Docmost DB, NOT sole reliance on manifest.
 */
const SLOTS = Object.freeze(['standard', 'human', 'ai'])
const OWNERS = Object.freeze({
  standard: 'mindmap',
  human: 'human',
  ai: 'ai'
})

async function ensureSchema(db) {
  if (!db || typeof db.query !== 'function') {
    throw new Error('docmostMappingStore.ensureSchema requires a pg pool')
  }
  await db.query(`
    create table if not exists knowledge_docmost_mappings (
      id bigserial primary key,
      room_id text not null,
      topic_key text not null,
      slot text not null check (slot in ('standard', 'human', 'ai')),
      owner text not null check (owner in ('mindmap', 'human', 'ai')),
      canonical_path text not null default '',
      docmost_space_id text not null default '',
      docmost_page_id text,
      content_hash text not null default '',
      last_synced_version text not null default '',
      title text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz,
      unique (room_id, topic_key, slot)
    );
    create index if not exists knowledge_docmost_mappings_room_idx
      on knowledge_docmost_mappings(room_id)
      where deleted_at is null;
    create index if not exists knowledge_docmost_mappings_page_idx
      on knowledge_docmost_mappings(docmost_page_id)
      where deleted_at is null and docmost_page_id is not null;
  `)
  // Phase 2 Wiki→Mindmap sync state (additive; safe on existing DBs)
  await db.query(`
    alter table knowledge_docmost_mappings
      add column if not exists last_sync_source text not null default '';
    alter table knowledge_docmost_mappings
      add column if not exists mindmap_hash text not null default '';
  `)
}

function assertSlot(slot) {
  if (!SLOTS.includes(slot)) throw new Error('invalid docmost mapping slot: ' + slot)
}

function expectedOwner(slot) {
  assertSlot(slot)
  return OWNERS[slot]
}

async function getMapping(db, { roomId, topicKey, slot }) {
  assertSlot(slot)
  const { rows } = await db.query(
    `select * from knowledge_docmost_mappings
      where room_id = $1 and topic_key = $2 and slot = $3 and deleted_at is null
      limit 1`,
    [String(roomId), String(topicKey), slot]
  )
  return rows[0] || null
}

async function getMappingByPageId(db, pageId) {
  const id = String(pageId || '').trim()
  if (!id) return null
  const { rows } = await db.query(
    `select * from knowledge_docmost_mappings
      where docmost_page_id = $1 and deleted_at is null
      limit 1`,
    [id]
  )
  return rows[0] || null
}

async function listRoomMappings(db, roomId) {
  const { rows } = await db.query(
    `select * from knowledge_docmost_mappings
      where room_id = $1 and deleted_at is null
      order by topic_key, slot`,
    [String(roomId)]
  )
  return rows
}

async function upsertMapping(db, row) {
  assertSlot(row.slot)
  const owner = row.owner || expectedOwner(row.slot)
  if (OWNERS[row.slot] !== owner) {
    throw new Error('owner/slot mismatch: slot=' + row.slot + ' owner=' + owner)
  }
  const { rows } = await db.query(
    `insert into knowledge_docmost_mappings (
        room_id, topic_key, slot, owner, canonical_path,
        docmost_space_id, docmost_page_id, content_hash,
        last_synced_version, title, last_sync_source, mindmap_hash,
        updated_at, deleted_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(), null)
      on conflict (room_id, topic_key, slot) do update set
        owner = excluded.owner,
        canonical_path = excluded.canonical_path,
        docmost_space_id = excluded.docmost_space_id,
        docmost_page_id = excluded.docmost_page_id,
        content_hash = excluded.content_hash,
        last_synced_version = excluded.last_synced_version,
        title = excluded.title,
        last_sync_source = coalesce(nullif(excluded.last_sync_source, ''), knowledge_docmost_mappings.last_sync_source),
        mindmap_hash = coalesce(nullif(excluded.mindmap_hash, ''), knowledge_docmost_mappings.mindmap_hash),
        updated_at = now(),
        deleted_at = null
      returning *`,
    [
      String(row.roomId),
      String(row.topicKey),
      row.slot,
      owner,
      String(row.canonicalPath || ''),
      String(row.docmostSpaceId || ''),
      row.docmostPageId || null,
      String(row.contentHash || ''),
      String(row.lastSyncedVersion || ''),
      String(row.title || ''),
      String(row.lastSyncSource || ''),
      String(row.mindmapHash || '')
    ]
  )
  return rows[0]
}

/**
 * Persist Wiki↔Mindmap sync state after a successful reverse sync.
 * content_hash = wiki markdown hash; mindmap_hash = subtree semantic hash.
 */
async function recordWikiMindmapSyncState(db, {
  roomId,
  topicKey,
  slot,
  wikiContentHash,
  mindmapHash,
  lastSyncSource = 'wiki',
  title
}) {
  assertSlot(slot)
  const { rows } = await db.query(
    `update knowledge_docmost_mappings
        set content_hash = $4,
            mindmap_hash = $5,
            last_sync_source = $6,
            last_synced_version = $5,
            title = coalesce(nullif($7, ''), title),
            updated_at = now()
      where room_id = $1 and topic_key = $2 and slot = $3 and deleted_at is null
      returning *`,
    [
      String(roomId),
      String(topicKey),
      slot,
      String(wikiContentHash || ''),
      String(mindmapHash || ''),
      String(lastSyncSource || 'wiki'),
      title == null ? '' : String(title)
    ]
  )
  return rows[0] || null
}

/**
 * Align last_synced_version without rewriting Docmost page content.
 * Used when content_hash already matches canonical but compile version advanced.
 */
async function bumpLastSyncedVersion(
  db,
  { roomId, topicKey, slot = 'standard', lastSyncedVersion }
) {
  assertSlot(slot)
  const version = String(lastSyncedVersion || '')
  const { rows } = await db.query(
    `update knowledge_docmost_mappings
        set last_synced_version = $4,
            updated_at = now()
      where room_id = $1 and topic_key = $2 and slot = $3
        and deleted_at is null
        and last_synced_version is distinct from $4
      returning *`,
    [String(roomId), String(topicKey), slot, version]
  )
  return rows[0] || null
}

async function softDeleteMapping(db, { roomId, topicKey, slot }) {
  assertSlot(slot)
  await db.query(
    `update knowledge_docmost_mappings
        set deleted_at = now(), updated_at = now()
      where room_id = $1 and topic_key = $2 and slot = $3 and deleted_at is null`,
    [String(roomId), String(topicKey), slot]
  )
}

async function softDeleteStandardByTopic(db, { roomId, topicKey }) {
  return softDeleteMapping(db, { roomId, topicKey, slot: 'standard' })
}

/**
 * Ownership guard before Canonical replace.
 * Returns { ok:true } or { ok:false, reason }
 */
function assertReplaceAllowed(mapping, { topicKey, expectedPageId } = {}) {
  if (!mapping) return { ok: false, reason: 'missing_mapping' }
  if (mapping.deleted_at) return { ok: false, reason: 'mapping_deleted' }
  if (mapping.slot !== 'standard') {
    return { ok: false, reason: 'slot_not_standard:' + mapping.slot }
  }
  if (mapping.owner !== 'mindmap') {
    return { ok: false, reason: 'owner_not_mindmap:' + mapping.owner }
  }
  if (topicKey != null && String(mapping.topic_key) !== String(topicKey)) {
    return { ok: false, reason: 'topic_mismatch' }
  }
  if (
    expectedPageId != null &&
    mapping.docmost_page_id &&
    String(mapping.docmost_page_id) !== String(expectedPageId)
  ) {
    return { ok: false, reason: 'page_id_mismatch' }
  }
  if (!mapping.docmost_page_id) return { ok: false, reason: 'missing_page_id' }
  return { ok: true }
}

function ownershipMarker({ roomId, topicKey, slot = 'standard', owner = 'mindmap' }) {
  return (
    '<!-- mind-map:ownership roomId=' +
    roomId +
    ' topicKey=' +
    topicKey +
    ' slot=' +
    slot +
    ' owner=' +
    owner +
    ' -->\n'
  )
}

function parseOwnershipMarker(markdown) {
  const text = String(markdown || '')
  const m = text.match(
    /<!--\s*mind-map:ownership\s+roomId=([^\s]+)\s+topicKey=([^\s]+)\s+slot=([^\s]+)\s+owner=([^\s]+)\s*-->/
  )
  if (!m) return null
  return { roomId: m[1], topicKey: m[2], slot: m[3], owner: m[4] }
}

function topicKeyFromCanonicalPath(file) {
  const f = String(file || '').replace(/^\/+/, '')
  if (!f || f === 'README.md') return 'README'
  return f
}

function standardTitle(baseTitle) {
  const base = String(baseTitle || '未命名').trim() || '未命名'
  if (/·\s*标准知识\s*$/.test(base)) return base.slice(0, 200)
  return (base + ' · 标准知识').slice(0, 200)
}

module.exports = {
  SLOTS,
  OWNERS,
  ensureSchema,
  getMapping,
  getMappingByPageId,
  listRoomMappings,
  upsertMapping,
  recordWikiMindmapSyncState,
  bumpLastSyncedVersion,
  softDeleteMapping,
  softDeleteStandardByTopic,
  assertReplaceAllowed,
  ownershipMarker,
  parseOwnershipMarker,
  topicKeyFromCanonicalPath,
  standardTitle,
  expectedOwner
}