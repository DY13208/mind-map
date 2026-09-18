const fs = require('fs')
const path = require('path')

// ---- 1) ACL fail-closed on DB errors ----
{
  const p = 'integrations/knowledge-mcp/src/acl/rooms.js'
  let s = fs.readFileSync(p, 'utf8')
  if (!s.includes('function mapAclDbError')) {
    const helper = `
function mapAclDbError(e) {
  const err = new Error('acl_unavailable')
  err.code = 'acl_unavailable'
  err.cause = e
  return err
}

async function withAclDb(fn) {
  try {
    return await fn()
  } catch (e) {
    if (e && (e.code === 'not_found' || e.code === 'forbidden_write' || e.code === 'forbidden_refresh' || e.code === 'acl_unavailable')) throw e
    throw mapAclDbError(e)
  }
}

`
    s = s.replace("let pool;\n", "let pool;\n" + helper)
    for (const name of ['listReadableRooms', 'getMembership', 'assertCanRead', 'assertCanWrite', 'assertCanRefresh']) {
      // wrap bodies by replacing function starts - simpler: wrap calls inside each async function
    }
    // Wrap the db operations in each exported async function
    s = s.replace(
      /async function listReadableRooms\(userId, env = process\.env\) \{\n  const db = getPool\(env\);\n  const \{ rows \} = await db\.query\(/,
      `async function listReadableRooms(userId, env = process.env) {\n  return withAclDb(async () => {\n  const db = getPool(env);\n  const { rows } = await db.query(`
    )
    // This gets messy - rewrite rooms.js cleanly instead
  }
}

// Rewrite rooms.js cleanly
{
  const p = 'integrations/knowledge-mcp/src/acl/rooms.js'
  const content = `'use strict';
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

async function listReadableRooms(userId, env = process.env) {
  return withAclDb(async () => {
    const db = getPool(env);
    const { rows } = await db.query(
      \`select room_key as "roomId", role
         from room_members
        where user_id = $1\`,
      [String(userId)],
    );
    return rows.filter((r) => READ_ROLES.has(String(r.role)));
  });
}

async function getMembership(userId, roomId, env = process.env) {
  return withAclDb(async () => {
    const db = getPool(env);
    const { rows } = await db.query(
      \`select room_key as "roomId", role
         from room_members
        where user_id = $1 and room_key = $2
        limit 1\`,
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
  READ_ROLES,
  WRITE_ROLES,
  REFRESH_ROLES,
};
`
  // Fix nested withAclDb double-wrap on assert* calling getMembership - getMembership throws acl_unavailable already, assert wraps again which remaps not_found incorrectly via mapAclDbError - mapAclDbError preserves not_found. Good.
  // But assertCanRead calls getMembership inside withAclDb, and getMembership has its own withAclDb - fine.
  fs.writeFileSync(p, content)
  console.log('wrote rooms.js')
}

console.log('rooms syntax')
require('child_process').execSync('node --check integrations/knowledge-mcp/src/acl/rooms.js', { stdio: 'inherit' })