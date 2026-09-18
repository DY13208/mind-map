const fs=require('fs');
function readJson(p){let b=fs.readFileSync(p);if(b[0]===0xEF&&b[1]===0xBB&&b[2]===0xBF)b=b.slice(3);return JSON.parse(b.toString('utf8'));}
const manPath='knowledge/ow-p2a-room-a/manifest.json';
const man=readJson(manPath);
if(man.documents && man.documents['branches/hiring-sop.md']){
  delete man.documents['branches/hiring-sop.md'];
  console.log('removed docs entry');
}
fs.writeFileSync(manPath, JSON.stringify(man,null,2)+'\n');
console.log(man.documents);
console.log('sop exists?', fs.existsSync('knowledge/ow-p2a-room-a/branches/hiring-sop.md'));
