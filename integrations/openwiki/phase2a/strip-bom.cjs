const fs=require('fs');
const p='knowledge/ow-p2a-room-a/branches/hiring-sop.md';
let s=fs.readFileSync(p);
if(s[0]===0xEF&&s[1]===0xBB&&s[2]===0xBF){s=s.slice(3);fs.writeFileSync(p,s);console.log('stripped BOM');}
else console.log('no BOM');
console.log(fs.readFileSync(p,'utf8'));
