const fs=require('fs');
function readJson(p){let b=fs.readFileSync(p);if(b[0]===0xEF&&b[1]===0xBB&&b[2]===0xBF)b=b.slice(3);return JSON.parse(b.toString('utf8'));}
const manPath='knowledge/ow-p2a-room-a/manifest.json';
const man=readJson(manPath);
fs.writeFileSync('integrations/openwiki/phase2a/artifacts/room-a-manifest-before-delete.json',JSON.stringify(man,null,2));
if(Array.isArray(man.documents)){
  man.documents=man.documents.filter(d=>{
    const name=typeof d==='string'?d:(d.path||d.file||d.name||JSON.stringify(d));
    return !String(name).includes('hiring-sop');
  });
} else if (man.files) {
  // try alternate shapes
}
fs.writeFileSync(manPath, JSON.stringify(man,null,2));
const sop='knowledge/ow-p2a-room-a/branches/hiring-sop.md';
if(fs.existsSync(sop)){
  fs.copyFileSync(sop,'integrations/openwiki/phase2a/artifacts/room-a-hiring-sop-deleted-backup.md');
  fs.unlinkSync(sop);
  console.log('deleted hiring-sop.md');
} else console.log('sop already gone');
console.log('manifest keys', Object.keys(man));
console.log('documents', man.documents || man.files || man);
