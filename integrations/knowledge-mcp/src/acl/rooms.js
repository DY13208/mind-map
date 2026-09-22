'use strict';
const { Pool } = require('pg');

const READ_ROLES = new Set(['owner', 'editor', 'viewer']);
const WRITE_ROLES = new Set(['owner', 'editor']);
const REFRESH_ROLES = new Set(['owner', 'editor']);
let pool;

function getPool(env = process.env) {
  if (pool) return pool;
  const url = env.MIND_MAP_DATABASE_URL || env.DATABASE_URL;
  pool = url
    ? new Pool({ connectionString: url, connectionTimeoutMillis: Number(env.KNOWLEDGE_MCP_TIMEOUT_ACL_MS || 3000) })
    : new Pool({
        host: env.PGHOST || 'postgres',
        port: Number(env.PGPORT || 5432),
        database: env.PGDATABASE || 'mind_map',
        user: env.PGUSER || 'postgres',
        password: env.PGPASSWORD || '',
        connectionTimeoutMillis: Number(env.KNOWLEDGE_MCP_TIMEOUT_ACL_MS || 3000),
      });
  return pool;
}

/** Reset cached pool (tests / ACL outage simulation). */
function resetPool() {
  if (pool) {
    try { pool.end() } catch (_) {}
  }
  pool = null;
}

function mapAclDbError(e) {
  if (e && ['not_found', 'forbidden_write', 'forbidden_refresh', 'acl_unavailable'].includes(e.code)) return e;
  const err = new Error('acl_unavailable');
  err.code = 'acl_unavailable';
  err.cause = e;
  return err;
}

async function withAclDb(fn) {
  try {
    return await fn();
  } catch (e) {
    throw mapAclDbError(e);
  }
}

function isSuperAdmin(userId, env = process.env) {
  const allow = String(env.MIND_MAP_SUPER_ADMIN_IDS || '')
    .split(/[,;\s]+/)
    .map((item) => String(item || '').trim().replace(/^wecom:/i, ''))
    .filter(Boolean);
  if (!allow.length) return false;
  const id = String(userId || '').trim().replace(/^wecom:/i, '');
  return !!id && allow.includes(id);
}

async function listReadableRooms(userId, env = process.env) {
  return withAclDb(async () => {
    const db = getPool(env);
    if (isSuperAdmin(userId, env)) {
      const { rows } = await db.query(
        `select room_key as "roomId", 'owner'::text as role
           from rooms r
           left join room_tombstones t on t.room_key = r.room_key
          where t.room_key is null and r.deleted_at is null`,
      );
      return rows;
    }
    const { rows } = await db.query(
      `select room_key as "roomId", role
         from room_members
        where user_id = $1`,
      [String(userId)],
    );
    return rows.filter((r) => READ_ROLES.has(String(r.role)));
  });
}

async function getMembership(userId, roomId, env = process.env) {
  return withAclDb(async () => {
    if (isSuperAdmin(userId, env)) {
      return { roomId: String(roomId), role: 'owner' };
    }
    const db = getPool(env);
    const { rows } = await db.query(
      `select room_key as "roomId", role
         from room_members
        where user_id = $1 and room_key = $2
        limit 1`,
      [String(userId), String(roomId)],
    );
    return rows[0] || null;
  });
}

async function assertCanRead(userId, roomId, env = process.env) {
  return withAclDb(async () => {
    const hit = await getMembership(userId, roomId, env);
    // getMembership already mapped; but if it returned null:
    if (!hit || !READ_ROLES.has(String(hit.role))) {
      const err = new Error('not_found');
      err.code = 'not_found';
      throw err;
    }
    return hit;
  });
}

async function assertCanWrite(userId, roomId, env = process.env) {
  return withAclDb(async () => {
    const hit = await getMembership(userId, roomId, env);
    if (!hit || !READ_ROLES.has(String(hit.role))) {
      const err = new Error('not_found');
      err.code = 'not_found';
      throw err;
    }
    if (!WRITE_ROLES.has(String(hit.role))) {
      const err = new Error('forbidden_write');
      err.code = 'forbidden_write';
      throw err;
    }
    return hit;
  });
}

async function assertCanRefresh(userId, roomId, env = process.env) {
  return withAclDb(async () => {
    const hit = await getMembership(userId, roomId, env);
    if (!hit || !READ_ROLES.has(String(hit.role))) {
      const err = new Error('not_found');
      err.code = 'not_found';
      throw err;
    }
    if (!REFRESH_ROLES.has(String(hit.role))) {
      const err = new Error('forbidden_refresh');
      err.code = 'forbidden_refresh';
      throw err;
    }
    return hit;
  });
}

module.exports = {
  getPool,
  resetPool,
  listReadableRooms,
  getMembership,
  assertCanRead,
  assertCanWrite,
  assertCanRefresh,
  isSuperAdmin,
  READ_ROLES,
  WRITE_ROLES,
  REFRESH_ROLES,
};
