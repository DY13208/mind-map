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
    ? new Pool({ connectionString: url })
    : new Pool({
        host: env.PGHOST || 'postgres',
        port: Number(env.PGPORT || 5432),
        database: env.PGDATABASE || 'mind_map',
        user: env.PGUSER || 'postgres',
        password: env.PGPASSWORD || '',
      });
  return pool;
}

async function listReadableRooms(userId, env = process.env) {
  const db = getPool(env);
  const { rows } = await db.query(
    `select room_key as "roomId", role
       from room_members
      where user_id = $1`,
    [String(userId)],
  );
  return rows.filter((r) => READ_ROLES.has(String(r.role)));
}

async function getMembership(userId, roomId, env = process.env) {
  const db = getPool(env);
  const { rows } = await db.query(
    `select room_key as "roomId", role
       from room_members
      where user_id = $1 and room_key = $2
      limit 1`,
    [String(userId), String(roomId)],
  );
  return rows[0] || null;
}

async function assertCanRead(userId, roomId, env = process.env) {
  const hit = await getMembership(userId, roomId, env);
  if (!hit || !READ_ROLES.has(String(hit.role))) {
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }
  return hit;
}

async function assertCanWrite(userId, roomId, env = process.env) {
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
}

async function assertCanRefresh(userId, roomId, env = process.env) {
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
}

module.exports = {
  getPool,
  listReadableRooms,
  getMembership,
  assertCanRead,
  assertCanWrite,
  assertCanRefresh,
  READ_ROLES,
  WRITE_ROLES,
  REFRESH_ROLES,
};