const fs=require('fs');
const path=require('path');
const root='knowledge/ow-p2a-room-a';
fs.mkdirSync(path.join(root,'branches'),{recursive:true});
const sopBackup='integrations/openwiki/phase2a/artifacts/room-a-hiring-sop-deleted-backup.md';
const manBackup='integrations/openwiki/phase2a/artifacts/room-a-manifest-before-delete.json';
if(fs.existsSync(sopBackup)) fs.copyFileSync(sopBackup, path.join(root,'branches/hiring-sop.md'));
if(fs.existsSync(manBackup)){
  let b=fs.readFileSync(manBackup); if(b[0]===0xEF) b=b.slice(3);
  fs.writeFileSync(path.join(root,'manifest.json'), b);
}
if(!fs.existsSync(path.join(root,'README.md'))){
  fs.writeFileSync(path.join(root,'README.md'), '# ow-p2a-room-a\n\nPhase 2A Canonical fixture room A (Hiring SOP).\n');
}
console.log('restored', fs.readdirSync(root), fs.readdirSync(path.join(root,'branches')));
