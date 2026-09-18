'use strict';
const fs = require('fs');
const path = require('path');
const { resolveUnder, fileExists, dirExists } = require('../utils/paths');
const { knowledgeResult } = require('../utils/result');
const { assertCanRead, listReadableRooms } = require('../acl/rooms');

function roomsRoot(env = process.env) {
  return path.resolve(env.OPENWIKI_ROOMS_ROOT || '/data/openwiki/rooms');
}

function roomWikiDir(roomId, env = process.env) {
  return path.join(roomsRoot(env), String(roomId), 'wiki');
}

function walkMd(dir, base = '') {
  if (!dirExists(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const rel = base ? `${base}/${name}` : name;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walkMd(full, rel));
    else if (st.isFile() && /\.md$/i.test(name)) out.push(rel.replace(/\\/g, '/'));
  }
  return out;
}

async function openwikiStatus(userId, { roomId } = {}, env = process.env) {
  const allowed = await listReadableRooms(userId, env);
  const rooms = roomId ? allowed.filter((a) => a.roomId === String(roomId)) : allowed;
  return rooms.map((a) => {
    const wiki = roomWikiDir(a.roomId, env);
    const ready = dirExists(wiki) && walkMd(wiki).length > 0;
    return {
      roomId: a.roomId,
      status: ready ? 'ready' : 'not_generated',
      path: `openwiki://room/${a.roomId}/`,
    };
  });
}

async function openwikiSearch(userId, { roomId, query } = {}, env = process.env) {
  const allowed = await listReadableRooms(userId, env);
  const allowSet = new Set(allowed.map((a) => a.roomId));
  const rooms = roomId ? [String(roomId)] : [...allowSet];
  const q = String(query || '').toLowerCase();
  const max = Number(env.KNOWLEDGE_MCP_MAX_RESULTS || 50);
  const out = [];
  for (const rid of rooms) {
    if (!allowSet.has(rid)) continue;
    const wiki = roomWikiDir(rid, env);
    if (!dirExists(wiki)) continue;
    for (const pagePath of walkMd(wiki)) {
      const full = path.join(wiki, pagePath);
      const text = fs.readFileSync(full, 'utf8');
      if (q && !text.toLowerCase().includes(q) && !pagePath.toLowerCase().includes(q)) continue;
      out.push(
        knowledgeResult({
          source: 'openwiki',
          authority: 'ai-derived',
          roomId: rid,
          title: path.basename(pagePath, '.md'),
          uri: `openwiki://room/${rid}/${pagePath}`,
          snippet: text.slice(0, 240),
          derived: true,
          updatedAt: fs.statSync(full).mtime.toISOString(),
        }),
      );
      if (out.length >= max) return out;
    }
  }
  return out;
}

async function openwikiRead(userId, { roomId, path: pagePath } = {}, env = process.env) {
  await assertCanRead(userId, roomId, env);
  const wiki = roomWikiDir(roomId, env);
  if (!dirExists(wiki)) return { status: 'not_generated', result: null };
  const full = resolveUnder(wiki, String(pagePath || '').replace(/^\/+/, ''));
  if (!fileExists(full)) {
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }
  const body = fs.readFileSync(full, 'utf8');
  return {
    status: 'ok',
    result: knowledgeResult({
      source: 'openwiki',
      authority: 'ai-derived',
      roomId: String(roomId),
      title: path.basename(full, '.md'),
      uri: `openwiki://room/${roomId}/${String(pagePath).replace(/^\/+/, '')}`,
      body: body.slice(0, Number(env.KNOWLEDGE_MCP_MAX_BODY || 120000)),
      snippet: body.slice(0, 240),
      derived: true,
      updatedAt: fs.statSync(full).mtime.toISOString(),
    }),
  };
}

module.exports = { openwikiSearch, openwikiRead, openwikiStatus, roomWikiDir, roomsRoot };
