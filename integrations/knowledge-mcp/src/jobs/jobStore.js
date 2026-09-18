'use strict';
const crypto = require('crypto');
const { getPool } = require('../acl/rooms');

async function ensureSchema(env = process.env) {
  const db = getPool(env);
  await db.query(`
    create table if not exists knowledge_openwiki_jobs (
      job_id text primary key,
      room_id text not null,
      requester_user_id text not null,
      status text not null,
      queued_at timestamptz not null default now(),
      started_at timestamptz,
      finished_at timestamptz,
      output_hash text,
      docmost_publish_status text,
      error text,
      result_json jsonb,
      lock_token text,
      updated_at timestamptz not null default now()
    );
    create index if not exists knowledge_openwiki_jobs_room_idx
      on knowledge_openwiki_jobs(room_id, queued_at desc);
    create index if not exists knowledge_openwiki_jobs_status_idx
      on knowledge_openwiki_jobs(status)
      where status in ('queued','running','generated','publishing');
  `);
}

function roomLockKey(roomId) {
  const h = crypto.createHash('md5').update(String(roomId)).digest();
  return h.readInt32BE(0);
}

async function withRoomAdvisoryLock(roomId, fn, env = process.env) {
  const db = getPool(env);
  const client = await db.connect();
  const key = roomLockKey(roomId);
  try {
    const got = await client.query('select pg_try_advisory_lock($1) as ok', [key]);
    if (!got.rows[0] || !got.rows[0].ok) {
      const err = new Error('room_busy');
      err.code = 'room_busy';
      throw err;
    }
    try {
      return await fn(client);
    } finally {
      try { await client.query('select pg_advisory_unlock($1)', [key]); } catch (_) {}
    }
  } finally {
    client.release();
  }
}

async function findActiveJob(roomId, env = process.env) {
  const db = getPool(env);
  const { rows } = await db.query(
    `select * from knowledge_openwiki_jobs
      where room_id=$1 and status = any($2::text[])
      order by queued_at desc limit 1`,
    [String(roomId), ['queued', 'running', 'generated', 'publishing']],
  );
  return rows[0] || null;
}

async function insertJob(job, env = process.env) {
  const db = getPool(env);
  const { rows } = await db.query(
    `insert into knowledge_openwiki_jobs (
      job_id, room_id, requester_user_id, status, queued_at, updated_at
    ) values ($1,$2,$3,'queued', now(), now())
    returning *`,
    [job.jobId, job.roomId, job.requesterUserId],
  );
  return rows[0];
}

async function getJob(jobId, env = process.env) {
  const db = getPool(env);
  const { rows } = await db.query(
    'select * from knowledge_openwiki_jobs where job_id=$1 limit 1',
    [String(jobId)],
  );
  return rows[0] || null;
}

async function updateJob(jobId, fields, env = process.env) {
  const db = getPool(env);
  const map = {
    status: 'status',
    startedAt: 'started_at',
    finishedAt: 'finished_at',
    outputHash: 'output_hash',
    docmostPublishStatus: 'docmost_publish_status',
    error: 'error',
    resultJson: 'result_json',
    lockToken: 'lock_token',
  };
  const sets = [];
  const vals = [jobId];
  let i = 2;
  for (const [k, v] of Object.entries(fields || {})) {
    const col = map[k];
    if (!col) continue;
    sets.push(col + '=$' + i);
    vals.push(v);
    i += 1;
  }
  if (!sets.length) return getJob(jobId, env);
  sets.push('updated_at=now()');
  const { rows } = await db.query(
    'update knowledge_openwiki_jobs set ' + sets.join(',') + ' where job_id=$1 returning *',
    vals,
  );
  return rows[0] || null;
}

async function reclaimStaleRunning(maxAgeMs = 15 * 60 * 1000, env = process.env) {
  const db = getPool(env);
  const ageMs = Number(maxAgeMs);
  const secs = Number.isFinite(ageMs) ? Math.max(0, Math.floor(ageMs / 1000)) : Math.floor((15 * 60 * 1000) / 1000);
  const sql = secs === 0
    ? `update knowledge_openwiki_jobs
          set status='failed',
              error=trim(both from coalesce(error,'') || ' | reclaimed_stale_running'),
              finished_at=now(),
              updated_at=now()
        where status in ('running','publishing')
        returning job_id, room_id`
    : `update knowledge_openwiki_jobs
          set status='failed',
              error=trim(both from coalesce(error,'') || ' | reclaimed_stale_running'),
              finished_at=now(),
              updated_at=now()
        where status in ('running','publishing')
          and updated_at < now() - make_interval(secs => $1::int)
        returning job_id, room_id`;
  const { rows } = secs === 0 ? await db.query(sql) : await db.query(sql, [secs]);
  return rows;
}
function rowToJob(row) {
  if (!row) return null;
  return {
    jobId: row.job_id,
    roomId: row.room_id,
    requesterUserId: row.requester_user_id,
    status: row.status,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outputHash: row.output_hash,
    docmostPublishStatus: row.docmost_publish_status,
    error: row.error,
    result: row.result_json,
  };
}

module.exports = {
  ensureSchema,
  withRoomAdvisoryLock,
  findActiveJob,
  insertJob,
  updateJob,
  getJob,
  reclaimStaleRunning,
  rowToJob,
  roomLockKey,
};
