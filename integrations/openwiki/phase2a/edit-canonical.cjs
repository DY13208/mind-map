const fs=require('fs');
const p='knowledge/ow-p2a-room-a/branches/hiring-sop.md';
let s=fs.readFileSync(p,'utf8');
if(!s.includes('P2A_EDIT_MARKER')){
  s=s.trimEnd()+'\n\n## Phase2A edit\nP2A_EDIT_MARKER_room-a-refresh-test\n';
  fs.writeFileSync(p,s);
  console.log('edited');
} else console.log('already edited');
console.log(fs.readFileSync(p,'utf8'));
