'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { assertCanRefresh, assertCanRead } = require('../acl/rooms');
const { withRoomLock } = require('../openwiki-runner/lock');
const { roomsRoot } = require('./openwiki');
const { docmostAiUpsert } = require('./docmostAi');
const jobStore = require('../jobs/jobStore');
const { breakers, withTimeout, timeouts } = require('../security/resilience');

let schemaReady = false;
async function ready(env) {
  if (!schemaReady) {
    await jobStore.ensureSchema(env);
    schemaReady = true;
  }
}

function deny(code, message) {
  const err = new Error(message || code);
  err.code = code;
  throw err;
}

function listMdFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  function walk(d, base) {
    for (const name of fs.readdirSync(d)) {
      const rel = base ? base + '/' + name : name;
      const full = path.join(d, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, rel);
      else if (st.isFile() && /\.md$/i.test(name) && name !== '_marker.md') {
        out.push(rel.replace(/\\/g, '/'));
      }
    }
  }
  walk(dir, '');
  return out;
}

function hashFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

async function runCli(roomId, env) {
  const cli = path.join(__dirname, '..', 'openwiki-runner', 'cli.js');
  const t = timeouts(env).openwiki;
  const run = new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--room', String(roomId)], {
      env,
      cwd: path.join(__dirname, '..', '..'),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const err = new Error('openwiki_cli_failed:' + code + ':' + String(stderr || stdout).slice(0, 300));
        err.code = 'openwiki_cli_failed';
        reject(err);
      }
    });
  });
  return withTimeout(run, t, 'openwiki');
}

async function publishOpenwikiToAi(userId, roomId, env) {
  const wikiDir = path.join(roomsRoot(env), String(roomId), 'wiki');
  const files = listMdFiles(wikiDir);
  const published = [];
  const failures = [];
  for (const rel of files) {
    const topicKey = 'openwiki:' + rel.replace(/\.md$/i, '');
    const full = path.join(wikiDir, rel);
    const body = fs.readFileSync(full, 'utf8');
    try {
      const res = await breakers.docmost.exec(() =>
        withTimeout(
          docmostAiUpsert(
            userId,
            {
              roomId,
              topicKey,
              content: body,
              optionalTitle: path.basename(rel, '.md') + ' · AI 整理',
            },
            env,
            { source: 'openwiki_refresh_publish' },
          ),
          timeouts(env).docmost,
          'docmost',
        ),
      );
      published.push({
        topicKey,
        pageId: res.audit && res.audit.docmostPageId,
        hash: hashFile(full),
      });
    } catch (e) {
      failures.push({ topicKey, error: e.code || String(e.message || e) });
    }
  }
  return {
    published,
    failures,
    outputHash: files.map((f) => hashFile(path.join(wikiDir, f))).join('|'),
  };
}

async function executeJob(jobRow, env) {
  const jobId = jobRow.job_id;
  const roomId = jobRow.room_id;
  const userId = jobRow.requester_user_id;
  await jobStore.updateJob(jobId, { status: 'running', startedAt: new Date().toISOString() }, env);
  try {
    await jobStore.withRoomAdvisoryLock(roomId, async () => {
      await withRoomLock(roomId, async () => {
        await breakers.openwiki.exec(() => runCli(roomId, env));
      }, env);
    }, env);

    await jobStore.updateJob(jobId, {
      status: 'generated',
      docmostPublishStatus: 'pending',
    }, env);

    const pub = await publishOpenwikiToAi(userId, roomId, env);
    const publishStatus = pub.failures.length === 0 ? 'ok' : (pub.published.length ? 'partial' : 'failed');
    let status = 'succeeded';
    let error = null;
    if (publishStatus === 'failed') {
      status = 'failed';
      error = 'docmost_publish_failed';
    } else if (publishStatus === 'partial') {
      status = 'failed';
      error = 'docmost_publish_partial';
      // keep generated output; allow retry publish
      status = 'generated';
    }
    await jobStore.updateJob(jobId, {
      status: publishStatus === 'ok' ? 'succeeded' : (publishStatus === 'partial' ? 'generated' : 'failed'),
      finishedAt: publishStatus === 'ok' ? new Date().toISOString() : null,
      outputHash: pub.outputHash,
      docmostPublishStatus: publishStatus,
      error,
      resultJson: pub,
    }, env);
  } catch (e) {
    await jobStore.updateJob(jobId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: String(e.code || e.message || e).slice(0, 300),
      docmostPublishStatus: 'skipped',
    }, env);
  }
  return jobStore.rowToJob(await jobStore.getJob(jobId, env));
}

function enqueue(jobRow, env) {
  setImmediate(() => {
    executeJob(jobRow, env).catch(async (e) => {
      try {
        await jobStore.updateJob(jobRow.job_id, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          error: String(e.message || e).slice(0, 300),
        }, env);
      } catch (_) {}
    });
  });
}

async function openwikiRefresh(userId, args = {}, env = process.env) {
  await ready(env);
  await jobStore.reclaimStaleRunning(Number(env.OPENWIKI_STALE_RUNNING_MS || 900000), env);
  const roomId = args.roomId;
  if (!roomId) deny('missing_params', 'roomId required');
  try {
    await assertCanRefresh(userId, roomId, env);
  } catch (e) {
    if (e.code === 'forbidden_refresh' || e.code === 'not_found') throw e;
    const err = new Error('acl_unavailable');
    err.code = 'acl_unavailable';
    throw err;
  }

  const active = await jobStore.findActiveJob(roomId, env);
  if (active) {
    enqueue(active, env);
    return {
      jobId: active.job_id,
      status: active.status === 'queued' ? 'queued' : active.status,
      coalesced: true,
      roomId: String(roomId),
    };
  }

  const jobId = crypto.randomUUID();
  const row = await jobStore.insertJob({
    jobId,
    roomId: String(roomId),
    requesterUserId: String(userId),
  }, env);
  enqueue(row, env);
  return { jobId, status: 'queued', coalesced: false, roomId: String(roomId) };
}

async function openwikiRefreshStatus(userId, args = {}, env = process.env) {
  await ready(env);
  const jobId = args.jobId;
  const roomId = args.roomId;
  if (jobId) {
    const row = await jobStore.getJob(jobId, env);
    if (!row) deny('not_found', 'job not found');
    await assertCanRead(userId, row.room_id, env);
    return jobStore.rowToJob(row);
  }
  if (!roomId) deny('missing_params', 'jobId or roomId required');
  await assertCanRead(userId, roomId, env);
  const active = await jobStore.findActiveJob(roomId, env);
  if (active) return jobStore.rowToJob(active);
  return { status: 'none', roomId: String(roomId) };
}

/** Retry Docmost publish only (no OpenWiki regenerate). */
async function openwikiRetryPublish(userId, args = {}, env = process.env) {
  await ready(env);
  const jobId = args.jobId;
  if (!jobId) deny('missing_params', 'jobId required');
  const row = await jobStore.getJob(jobId, env);
  if (!row) deny('not_found', 'job not found');
  await assertCanRefresh(userId, row.room_id, env);
  if (!['generated', 'failed'].includes(row.status) && row.docmost_publish_status === 'ok') {
    return jobStore.rowToJob(row);
  }
  // Only retry publish when wiki already generated
  if (!['generated', 'failed', 'succeeded'].includes(row.status)) {
    deny('invalid_state', 'job not ready for publish retry');
  }
  await jobStore.updateJob(jobId, { status: 'publishing', error: null }, env);
  try {
    const pub = await publishOpenwikiToAi(userId, row.room_id, env);
    const publishStatus = pub.failures.length === 0 ? 'ok' : (pub.published.length ? 'partial' : 'failed');
    const updated = await jobStore.updateJob(jobId, {
      status: publishStatus === 'ok' ? 'succeeded' : 'generated',
      finishedAt: publishStatus === 'ok' ? new Date().toISOString() : null,
      outputHash: pub.outputHash || row.output_hash,
      docmostPublishStatus: publishStatus,
      error: publishStatus === 'ok' ? null : 'docmost_publish_' + publishStatus,
      resultJson: pub,
    }, env);
    return jobStore.rowToJob(updated);
  } catch (e) {
    const updated = await jobStore.updateJob(jobId, {
      status: 'generated',
      docmostPublishStatus: 'failed',
      error: String(e.code || e.message || e).slice(0, 300),
    }, env);
    return jobStore.rowToJob(updated);
  }
}

module.exports = {
  openwikiRefresh,
  openwikiRefreshStatus,
  openwikiRetryPublish,
  executeJob,
};
