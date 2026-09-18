'use strict';
const { Pool } = require('pg');

const READ_ROLES = new Set(['owner', 'editor', 'viewer']);
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

async function assertCanRead(userId, roomId, env = process.env) {
  const rooms = await listReadableRooms(userId, env);
  const hit = rooms.find((r) => r.roomId === String(roomId));
  if (!hit) {
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }
  return hit;
}

module.exports = { getPool, listReadableRooms, assertCanRead, READ_ROLES };
