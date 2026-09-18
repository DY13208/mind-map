#!/bin/sh
set -e
echo "=== wiki dir ==="
find /data/openwiki/wiki -maxdepth 3 2>/dev/null | head -50
ls -la /data/openwiki/wiki
echo "=== sample knowledge room files ==="
ls /knowledge | head -20
# pick a room with README.md
for d in /knowledge/room-*; do
  if [ -f "$d/README.md" ] && [ -f "$d/manifest.json" ]; then
    echo "PICK $d"
    ls -la "$d" | head
    echo "manifest keys:"; node -e "const m=require(process.argv[1]); console.log(Object.keys(m)); console.log(JSON.stringify({lastCompiledVersion:m.lastCompiledVersion,publicationId:m.publicationId,docs:Object.keys(m.documents||{}).slice(0,5),nodes:Object.keys(m.nodes||{}).length},null,2))" "$d/manifest.json"
    break
  fi
done
# also check any room with documents key
node <<'NODE'
const fs=require('fs'); const path=require('path');
const root='/knowledge';
let found=null, sample=null;
for (const name of fs.readdirSync(root)) {
  const mf=path.join(root,name,'manifest.json');
  if (!fs.existsSync(mf)) continue;
  const m=JSON.parse(fs.readFileSync(mf,'utf8'));
  sample = sample || {name, keys:Object.keys(m)};
  if (m.documents) { found={name, keys:Object.keys(m), docs:Object.keys(m.documents).slice(0,8), ver:m.lastCompiledVersion, pub:m.publicationId}; break; }
}
console.log('sampleRoom', sample);
console.log('documentsFormatRoom', found);
NODE