const fs = require('fs');
const p = 'integrations/openclaw/phase3/run_acceptance.js';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(
  /require\(['"][^'"]*auth\/jwt['"]\)/,
  "require('../../knowledge-mcp/src/auth/jwt')"
);
const jwt = require('./integrations/knowledge-mcp/src/auth/jwt');
console.log('jwt keys', Object.keys(jwt));
if (jwt.signToken && s.includes('signToken')) {
  // ok
} else if (jwt.signToken) {
  s = s.replace(/signToken/g, 'signToken');
}
fs.writeFileSync(p, s);
console.log('patched require');
