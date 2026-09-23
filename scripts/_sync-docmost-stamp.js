// 一次性工具：复刻 scripts/docker-up.js 的 hashDocmostSources()，
// 手动 build docmost 镜像后同步 .docker-build-stamps/docmost.sha
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.cwd();
const docmostDir = path.join(ROOT, 'integrations', 'docmost');
const skipDir = new Set(['.git', 'node_modules', 'dist', 'build', '.nx', 'coverage', '.turbo', 'tmp', 'temp']);
const out = [];

(function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (skipDir.has(ent.name)) continue;
      walk(full);
      continue;
    }
    if (!ent.isFile()) continue;
    if (ent.name === '.env' || ent.name.endsWith('.env.local')) continue;
    out.push(full);
  }
})(docmostDir);
out.sort();

const hash = crypto.createHash('sha256');
for (const filePath of out) {
  const rel = path.relative(docmostDir, filePath).split(path.sep).join('/');
  const st = fs.statSync(filePath);
  hash.update(rel);
  hash.update('\0');
  hash.update(String(st.size));
  hash.update('\0');
  hash.update(String(Math.floor(st.mtimeMs)));
  hash.update('\0');
  if (st.size <= 512 * 1024) hash.update(fs.readFileSync(filePath));
  hash.update('\n');
}
hash.update('image=mind-map-docmost\n');
hash.update('version=' + String(process.env.DOCMOST_VERSION || '0.96.0') + '\n');

const digest = hash.digest('hex');
fs.mkdirSync(path.join(ROOT, '.docker-build-stamps'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.docker-build-stamps', 'docmost.sha'), digest + '\n', 'utf8');
console.log('stamp updated:', digest.slice(0, 16) + '... files=' + out.length);
