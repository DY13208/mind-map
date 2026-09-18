'use strict';
const { getPool, assertCanRead, assertCanWrite } = require('../acl/rooms');
const { knowledgeResult } = require('../utils/result');
const {
  cfg,
  createPage,
  updatePage,
  readPageText,
  contentHash,
} = require('./docmostWriteClient');

const AI_BANNER = [
  '> **AI 整理内容**（机读维护，下次刷新可能整页替换）',
  '> 基于当前标准知识与已授权资料生成；需要长期保留请移到 human 团队经验页。',
  '',
].join('\n');

function deny(code, message) {
  const err = new Error(message || code);
  err.code = code;
  throw err;
}

function assertAiOwnership(row) {
  if (!row || row.deleted_at) return { ok: false, reason: 'missing_mapping' };
  if (String(row.slot) !== 'ai') return { ok: false, reason: 'slot_not_ai' };
  if (String(row.owner) !== 'ai') return { ok: false, reason: 'owner_not_ai' };
  return { ok: true };
}

function wrapAiMarkdown(body) {
  const raw = String(body || '');
  if (raw.includes('AI 整理内容')) return raw;
  return AI_BANNER + raw;
}

function mapAiRow(row, extra) {
  return knowledgeResult(Object.assign({
    source: 'docmost',
    authority: 'ai-derived',
    roomId: row.room_id,
    topicKey: row.topic_key,
    title: row.title || row.topic_key,
    uri: row.docmost_page_id ? 'docmost://page/' + row.docmost_page_id : null,
    owner: 'ai',
    pageType: 'ai',
    derived: true,
    version: row.last_synced_version || null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  }, extra || {}));
}

async function loadMapping(db, roomId, topicKey, slot) {
  const { rows } = await db.query(
    'select * from knowledge_docmost_mappings where deleted_at is null and room_id=$1 and topic_key=$2 and slot=$3 limit 1',
    [String(roomId), String(topicKey), String(slot)]
  );
  return rows[0] || null;
}

async function resolveSpaceId(db, roomId) {
  const { rows } = await db.query(
    "select docmost_space_id from knowledge_docmost_mappings where deleted_at is null and room_id=$1 and coalesce(docmost_space_id,'') <> '' order by case when slot='standard' then 0 when slot='human' then 1 else 2 end limit 1",
    [String(roomId)]
  );
  return rows[0] ? rows[0].docmost_space_id : null;
}

async function upsertAiMapping(db, fields) {
  const { rows } = await db.query(
    'insert into knowledge_docmost_mappings (room_id, topic_key, slot, owner, canonical_path, docmost_space_id, docmost_page_id, content_hash, last_synced_version, title, updated_at, deleted_at) values ($1,$2,\'ai\',\'ai\',$3,$4,$5,$6,$7,$8, now(), null) on conflict (room_id, topic_key, slot) do update set owner = excluded.owner, canonical_path = excluded.canonical_path, docmost_space_id = excluded.docmost_space_id, docmost_page_id = excluded.docmost_page_id, content_hash = excluded.content_hash, last_synced_version = excluded.last_synced_version, title = excluded.title, updated_at = now(), deleted_at = null returning *',
    [String(fields.roomId), String(fields.topicKey), String(fields.canonicalPath || ''), String(fields.spaceId || ''), fields.pageId || null, String(fields.hash || ''), String(fields.version || ''), String(fields.title || '')]
  );
  return rows[0];
}

async function docmostAiGet(userId, args, env) {
  args = args || {};
  env = env || process.env;
  const roomId = args.roomId;
  const topicKey = args.topicKey;
  if (!roomId || !topicKey) deny('missing_params', 'roomId and topicKey required');
  await assertCanRead(userId, roomId, env);
  const db = getPool(env);
  const row = await loadMapping(db, roomId, topicKey, 'ai');
  if (!row) return { status: 'not_created', result: null };
  const guard = assertAiOwnership(row);
  if (!guard.ok) return { status: 'ownership_invalid', reason: guard.reason, result: mapAiRow(row) };
  if (!row.docmost_page_id) return { status: 'not_created', result: mapAiRow(row) };
  const page = await readPageText(row.docmost_page_id, env);
  return {
    status: 'ok',
    result: mapAiRow(row, {
      body: page ? String(page.text || '').slice(0, Number(env.KNOWLEDGE_MCP_MAX_BODY || 120000)) : null,
      snippet: page ? String(page.text || '').slice(0, 240) : null,
      title: (page && page.title) || row.title || row.topic_key,
    }),
  };
}

async function docmostAiUpsert(userId, args, env, auditExtra) {
  args = args || {};
  env = env || process.env;
  auditExtra = auditExtra || {};
  const started = Date.now();
  const roomId = args.roomId;
  const topicKey = args.topicKey;
  const content = args.content;
  const optionalTitle = args.optionalTitle;
  if (!roomId || !topicKey) deny('missing_params', 'roomId and topicKey required');
  if (content == null) deny('missing_params', 'content required');
  await assertCanWrite(userId, roomId, env);
  const conf = cfg(env);
  if (!conf.databaseUrl || !conf.appSecret) deny('docmost_unavailable', 'Docmost write path not configured');
  const db = getPool(env);
  let row = await loadMapping(db, roomId, topicKey, 'ai');
  let beforeHash = null;
  let created = false;
  if (row) {
    const guard = assertAiOwnership(row);
    if (!guard.ok) deny('ownership_guard', 'refusing write: ' + guard.reason);
    if (row.docmost_page_id) {
      const page = await readPageText(row.docmost_page_id, env);
      beforeHash = contentHash(page ? page.text : '');
    }
  }
  const title = String(optionalTitle || (row && row.title) || (topicKey + ' · AI 整理')).slice(0, 200);
  const markdown = wrapAiMarkdown(content);
  const afterHash = contentHash(markdown);
  let pageId = row && row.docmost_page_id ? String(row.docmost_page_id) : null;
  const spaceId = (row && row.docmost_space_id) || (await resolveSpaceId(db, roomId));
  if (!spaceId) deny('no_space', 'no Docmost space mapped for room; sync standard first');
  try {
    if (pageId) {
      await updatePage({ pageId: pageId, title: title, markdown: markdown, env: env });
    } else {
      pageId = await createPage({ spaceId: spaceId, title: title, markdown: markdown, env: env });
      if (!pageId) deny('docmost_create_failed', 'createPage returned empty id');
      created = true;
    }
  } catch (e) {
    if (e.code && String(e.code).indexOf('docmost_') === 0) throw e;
    const err = new Error('docmost_write_failed:' + String(e.message || e).slice(0, 160));
    err.code = 'docmost_write_failed';
    err.cause = e;
    throw err;
  }
  const version = 'ai-' + Date.now();
  row = await upsertAiMapping(db, {
    roomId: roomId,
    topicKey: topicKey,
    canonicalPath: (row && row.canonical_path) || '',
    spaceId: spaceId,
    pageId: pageId,
    hash: afterHash,
    version: version,
    title: title,
  });
  return {
    status: 'ok',
    created: created,
    result: mapAiRow(row, {
      body: markdown.slice(0, Number(env.KNOWLEDGE_MCP_MAX_BODY || 120000)),
      snippet: markdown.slice(0, 240),
    }),
    audit: Object.assign({}, auditExtra, {
      operation: created ? 'ai_create' : 'ai_update',
      targetSlot: 'ai',
      docmostPageId: pageId,
      beforeHash: beforeHash,
      afterHash: afterHash,
      topicKey: String(topicKey),
      durationMs: Date.now() - started,
    }),
  };
}

module.exports = {
  docmostAiGet: docmostAiGet,
  docmostAiUpsert: docmostAiUpsert,
  assertAiOwnership: assertAiOwnership,
  wrapAiMarkdown: wrapAiMarkdown,
  AI_BANNER: AI_BANNER,
  loadMapping: loadMapping,
};