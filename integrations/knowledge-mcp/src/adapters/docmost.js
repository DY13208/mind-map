'use strict';
const { Pool } = require('pg');
const { getPool, assertCanRead, listReadableRooms } = require('../acl/rooms');
const { knowledgeResult, authorityForDocmostSlot } = require('../utils/result');

let docmostPool;

function getDocmostPool(env = process.env) {
  if (docmostPool) return docmostPool;
  const url = env.DOCMOST_DATABASE_URL;
  if (!url) return null;
  docmostPool = new Pool({ connectionString: url });
  return docmostPool;
}

function mapRow(row) {
  return knowledgeResult({
    source: 'docmost',
    authority: authorityForDocmostSlot(row.slot, row.owner),
    roomId: row.room_id,
    topicKey: row.topic_key,
    title: row.title || row.topic_key,
    uri: row.docmost_page_id
      ? `docmost://page/${row.docmost_page_id}`
      : `docmost://room/${row.room_id}/${row.topic_key}/${row.slot}`,
    owner: row.owner,
    pageType: row.slot,
    derived: row.slot === 'ai' || row.owner === 'ai',
    version: row.last_synced_version || null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  });
}

async function docmostSearch(userId, { roomId, query } = {}, env = process.env) {
  try {
  const allowed = await listReadableRooms(userId, env);
  const ids = roomId
    ? allowed.filter((a) => a.roomId === String(roomId)).map((a) => a.roomId)
    : allowed.map((a) => a.roomId);
  if (!ids.length) return [];
  const db = getPool(env);
  const params = [ids];
  let sql = `select * from knowledge_docmost_mappings
              where deleted_at is null and room_id = any($1::text[])`;
  if (query) {
    params.push(`%${String(query).slice(0, 200)}%`);
    sql += ` and (coalesce(title,'') ilike $2 or topic_key ilike $2)`;
  }
  sql += ' order by room_id, topic_key, slot limit 200';
  const { rows } = await db.query(sql, params);
  return rows.map(mapRow);
  } catch (e) {
    if (e && (e.code === 'not_found' || e.code === 'acl_unavailable' || e.code === 'forbidden_write' || e.code === 'source_unavailable')) throw e;
    const err = new Error('source_unavailable:docmost');
    err.code = 'source_unavailable'; err.source = 'docmost'; err.cause = e; throw err;
  }
}

async function docmostGet(userId, { roomId, topicKey, slot, pageId } = {}, env = process.env) {
  const db = getPool(env);
  let row;
  if (pageId) {
    const allowed = await listReadableRooms(userId, env);
    const ids = allowed.map((a) => a.roomId);
    const { rows } = await db.query(
      `select * from knowledge_docmost_mappings
        where deleted_at is null and docmost_page_id = $1
          and room_id = any($2::text[]) limit 1`,
      [String(pageId), ids],
    );
    row = rows[0];
  } else {
    if (!roomId || !topicKey || !slot) {
      const err = new Error('missing_params');
      err.code = 'missing_params';
      throw err;
    }
    await assertCanRead(userId, roomId, env);
    const { rows } = await db.query(
      `select * from knowledge_docmost_mappings
        where deleted_at is null and room_id=$1 and topic_key=$2 and slot=$3
        limit 1`,
      [String(roomId), String(topicKey), String(slot)],
    );
    row = rows[0];
  }
  if (!row) return { status: 'not_created', result: null };
  if (!row.docmost_page_id) return { status: 'not_created', result: mapRow(row) };
  const result = mapRow(row);
  const dpool = getDocmostPool(env);
  if (dpool) {
    try {
      const { rows } = await dpool.query(
        `select id::text as id, title, content, updated_at from pages where id::text=$1 limit 1`,
        [String(row.docmost_page_id)],
      );
      if (rows[0]) {
        const content =
          typeof rows[0].content === 'string'
            ? rows[0].content
            : JSON.stringify(rows[0].content ?? '');
        result.title = rows[0].title || result.title;
        result.body = content.slice(0, Number(env.KNOWLEDGE_MCP_MAX_BODY || 120000));
        result.snippet = content.slice(0, 240);
        result.updatedAt = rows[0].updated_at
          ? new Date(rows[0].updated_at).toISOString()
          : result.updatedAt;
      }
    } catch (e) {
      result.snippet = `docmost_read_error:${String(e.message || e).slice(0, 80)}`;
    }
  }
  return { status: 'ok', result };
}

module.exports = { docmostSearch, docmostGet };
