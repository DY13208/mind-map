#!/bin/sh
set -e
# Simulate MCP list_knowledge via requiring the script is hard (stdio). Use node inline replicate.
node <<'NODE'
const fs=require('fs'); const path=require('path'); const crypto=require('crypto');
const root='/knowledge';
async function roomManifest(roomId){
  const dir=path.join(root,roomId);
  try { await fs.promises.access(path.join(dir,'.transaction')); throw new Error('pending'); } catch(e){ if(e.code!=='ENOENT') throw e; }
  return {dir, manifest: JSON.parse(await fs.promises.readFile(path.join(dir,'manifest.json'),'utf8'))};
}
(async()=>{
  const rooms=[];
  for (const room of await fs.promises.readdir(root,{withFileTypes:true})) {
    if (!room.isDirectory() || room.name.startsWith('.')) continue;
    try {
      const {manifest}=await roomManifest(room.name);
      rooms.push({roomId:room.name, version:manifest.lastCompiledVersion, files:Object.keys(manifest.documents||{}), hasDocuments:!!manifest.documents, keys:Object.keys(manifest)});
    } catch(err) {
      rooms.push({roomId:room.name, error:String(err.message||err)});
    }
  }
  const ok=rooms.filter(r=>r.files && r.files.length);
  const bad=rooms.filter(r=>r.error || (r.hasDocuments===false));
  console.log(JSON.stringify({total:rooms.length, withDocuments:ok.length, brokenOrLegacy:bad.length, okSample:ok.slice(0,3), badSample:bad.slice(0,8)},null,2));
})();
NODE