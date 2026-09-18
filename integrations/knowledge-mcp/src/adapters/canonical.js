'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveUnder, fileExists, dirExists } = require('../utils/paths');
const { knowledgeResult } = require('../utils/result');
const { assertCanRead, listReadableRooms } = require('../acl/rooms');

function knowledgeRoot(env = process.env) {
  return path.resolve(env.KNOWLEDGE_ROOT || '/data/knowledge');
}

function readManifest(roomDir) {
  const p = path.join(roomDir, 'manifest.json');
  if (!fileExists(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function manifestPaths(manifest) {
  if (!manifest) return null;
  if (Array.isArray(manifest.documents)) {
    return manifest.documents
      .map((d) => (typeof d === 'string' ? d : d && d.path))
      .filter(Boolean)
      .map((p) => String(p).replace(/^\/+/, ''));
  }
  if (manifest.nodes && typeof manifest.nodes === 'object') {
    const set = new Set();
    for (const n of Object.values(manifest.nodes)) {
      if (n && n.path) set.add(String(n.path).replace(/^\/+/, ''));
    }
    return [...set];
  }
  return null;
}

function walkFiles(dir, base = '') {
  const out = [];
  if (!dirExists(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const rel = base ? base + '/' + name : name;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walkFiles(full, rel));
    else if (st.isFile()) out.push(rel.replace(/\\/g, '/'));
  }
  return out;
}

async function canonicalList(userId, { roomId } = {}, env = process.env) {
  const rootCheck = knowledgeRoot(env);
  try { fs.accessSync(rootCheck, fs.constants.R_OK); } catch (e) {
    const err = new Error('source_unavailable:canonical');
    err.code = 'source_unavailable'; err.source = 'canonical'; throw err;
  }
  const allowed = await listReadableRooms(userId, env);
  const allow = new Set(allowed.map((a) => a.roomId));
  const rooms = roomId ? [String(roomId)] : [...allow];
  const root = knowledgeRoot(env);
  const results = [];
  for (const rid of rooms) {
    if (!allow.has(rid)) continue;
    const roomDir = path.join(root, rid);
    if (!dirExists(roomDir)) continue;
    const manifest = readManifest(roomDir);
    const docs = manifestPaths(manifest) || walkFiles(roomDir);
    for (const p of docs) {
      results.push(
        knowledgeResult({
          source: 'canonical',
          authority: 'formal',
          roomId: rid,
          title: path.basename(p),
          uri: 'canonical://room/' + rid + '/' + p,
          version: manifest && (manifest.version || manifest.rev || null),
          updatedAt: manifest && (manifest.updatedAt || null),
        }),
      );
    }
  }
  return results;
}

async function canonicalRead(userId, { roomId, path: relPath } = {}, env = process.env) {
  await assertCanRead(userId, roomId, env);
  const roomDir = path.join(knowledgeRoot(env), String(roomId));
  if (!dirExists(roomDir)) {
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }
  const manifest = readManifest(roomDir);
  const allowed = manifestPaths(manifest);
  const rel = String(relPath || '').replace(/^\/+/, '');
  if (allowed && !allowed.includes(rel)) {
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }
  const full = resolveUnder(roomDir, rel);
  if (!fileExists(full)) {
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }
  const body = fs.readFileSync(full, 'utf8');
  return knowledgeResult({
    source: 'canonical',
    authority: 'formal',
    roomId: String(roomId),
    title: path.basename(rel),
    uri: 'canonical://room/' + roomId + '/' + rel,
    body: body.slice(0, Number(env.KNOWLEDGE_MCP_MAX_BODY || 200000)),
    snippet: body.slice(0, 280),
    updatedAt: fs.statSync(full).mtime.toISOString(),
  });
}

function hashKnowledgeTree(env = process.env) {
  const root = knowledgeRoot(env);
  const h = crypto.createHash('sha256');
  function walk(d) {
    if (!dirExists(d)) return;
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else {
        h.update(path.relative(root, full).replace(/\\/g, '/'));
        h.update(fs.readFileSync(full));
      }
    }
  }
  walk(root);
  return h.digest('hex');
}

module.exports = {
  knowledgeRoot,
  canonicalList,
  canonicalRead,
  hashKnowledgeTree,
};
