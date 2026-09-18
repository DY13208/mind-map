const fs = require('fs');
const p = 'integrations/knowledge-mcp/src/adapters/openwikiRefresh.js';
let s = fs.readFileSync(p, 'utf8');
// ACL export is assertCanRefresh
s = s.split('assertCanRefresh').join('assertCanRefresh');
// But wait — if both become same via wrong join, force correct from rooms.js
const rooms = fs.readFileSync('integrations/knowledge-mcp/src/acl/rooms.js', 'utf8');
if (!rooms.includes('assertCanRefresh')) {
  console.error('rooms.js missing assertCanRefresh');
  process.exit(1);
}
// Ensure require line
s = s.replace(
  /const \{[^}]+\} = require\('\.\.\/acl\/rooms'\);/,
  "const { assertCanRefresh, assertCanRead } = require('../acl/rooms');"
);
// Ensure calls use assertCanRefresh
s = s.replace(/await assertCanRefresh\(/g, 'await assertCanRefresh(');
s = s.replace(/await assertCanRead\(/g, 'await assertCanRead(');
// lock export
const lock = fs.readFileSync('integrations/knowledge-mcp/src/openwiki-runner/lock.js', 'utf8');
console.log('lock has withRoomLock', lock.includes('withRoomLock'));
s = s.replace(
  /const \{[^}]+\} = require\('\.\.\/openwiki-runner\/lock'\);/,
  "const { withRoomLock } = require('../openwiki-runner/lock');"
);
// openwiki roomsRoot
s = s.replace(
  /const \{[^}]+\} = require\('\.\/openwiki'\);/,
  "const { roomsRoot } = require('./openwiki');"
);
// Fix roomPointerPath consistency: define + use roomPointerPath
if (!s.includes('function roomPointerPath')) {
  s = s.replace(
    'function jobPath(jobId, env) {',
    "function roomPointerPath(roomId, env) {\n  return path.join(jobsRoot(env), 'rooms', String(roomId) + '.json');\n}\n\nfunction jobPath(jobId, env) {"
  );
}
fs.writeFileSync(p, s);
console.log('patched');
console.log('require rooms line', s.split('\n').find((l) => l.includes("acl/rooms")));
console.log('assertCanRefresh', (s.match(/assertCanRefresh/g) || []).length);
