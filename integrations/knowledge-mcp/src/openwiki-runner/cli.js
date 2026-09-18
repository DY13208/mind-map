'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withRoomLock, tryAcquireFileLock, releaseFileLock } = require('./lock');
const { knowledgeRoot } = require('../adapters/canonical');
const { roomsRoot } = require('../adapters/openwiki');
const { resolveUnder, dirExists } = require('../utils/paths');

function parseArgs(argv) {
  const out = { room: null, marker: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--room') out.room = argv[++i];
    else if (argv[i] === '--marker') out.marker = argv[++i];
  }
  return out;
}

function hashDir(dir) {
  const h = crypto.createHash('sha256');
  function walk(d) {
    if (!dirExists(d)) return;
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else {
        h.update(path.relative(dir, full));
        h.update(fs.readFileSync(full));
      }
    }
  }
  walk(dir);
  return h.digest('hex');
}

function copyCanonicalSnapshot(roomId, destWiki) {
  const src = path.join(knowledgeRoot(), String(roomId));
  if (!dirExists(src)) throw new Error('canonical_room_missing:' + roomId);
  fs.mkdirSync(destWiki, { recursive: true });
  let n = 0;
  function walk(d, base = '') {
    for (const name of fs.readdirSync(d)) {
      const rel = base ? `${base}/${name}` : name;
      const full = path.join(d, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, rel);
      else if (st.isFile() && /\.md$/i.test(name)) {
        const to = resolveUnder(destWiki, rel.replace(/\\/g, '/'));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        const body = fs.readFileSync(full, 'utf8');
        fs.writeFileSync(
          to,
          `<!-- openwiki-derived room=${roomId} source=canonical -->\n# OpenWiki (AI-derived)\n\n${body}`,
          'utf8',
        );
        n += 1;
      }
    }
  }
  walk(src);
  return n;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.room) {
    console.error('Usage: --room <roomId> [--marker TEXT]');
    process.exit(2);
  }
  const roomId = args.room;
  const roomOut = path.join(roomsRoot(), roomId);
  const wikiDir = path.join(roomOut, 'wiki');
  const canonDir = path.join(knowledgeRoot(), roomId);
  const before = hashDir(canonDir);

  await withRoomLock(roomId, async () => {
    if (!tryAcquireFileLock(roomOut)) throw new Error('room_busy');
    try {
      if (dirExists(wikiDir)) fs.rmSync(wikiDir, { recursive: true, force: true });
      const n = copyCanonicalSnapshot(roomId, wikiDir);
      if (args.marker) {
        fs.writeFileSync(path.join(wikiDir, '_marker.md'), `# Marker\n\n${args.marker}\n`, 'utf8');
      }
      fs.writeFileSync(
        path.join(roomOut, 'status.json'),
        JSON.stringify(
          {
            roomId,
            generatedAt: new Date().toISOString(),
            pages: n + (args.marker ? 1 : 0),
            mode: 'canonical-snapshot-derived',
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify({ ok: true, roomId, pages: n }));
    } finally {
      releaseFileLock(roomOut);
    }
  });

  const after = hashDir(canonDir);
  if (before !== after) {
    console.error('CANONICAL_HASH_CHANGED', before, after);
    process.exit(3);
  }
  console.log(JSON.stringify({ canonicalHashUnchanged: true, hash: before }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
