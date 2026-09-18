const fs = require('fs');
const path = require('path');
const root = 'D:/mind-map/integrations/knowledge-mcp/src';
const serverPath = path.join(root, 'server.js');
let s = fs.readFileSync(serverPath, 'utf8');

const jwt = require(path.join(root, 'auth/jwt.js'));
const audit = require(path.join(root, 'audit/log.js'));
const rooms = require(path.join(root, 'acl/rooms.js'));
const docmostAi = require(path.join(root, 'adapters/docmostAi.js'));
const refresh = require(path.join(root, 'adapters/openwikiRefresh.js'));
const rate = require(path.join(root, 'security/rateLimit.js'));
const jobs = require(path.join(root, 'jobs/jobStore.js'));

const bearer = Object.keys(jwt).find((k) => /bearer|extract/i.test(k));
const verify = Object.keys(jwt).find((k) => /verify/i.test(k));
const auditFn = Object.keys(audit)[0];
const poolFn = Object.keys(rooms).find((k) => /pool/i.test(k));
const aiGet = Object.keys(docmostAi).find((k) => /get/i.test(k) && /ai/i.test(k));
const aiUpsert = Object.keys(docmostAi).find((k) => /upsert/i.test(k));
const refreshStatusFn = Object.keys(refresh).find((k) => /status/i.test(k));
const retryFn = Object.keys(refresh).find((k) => /retry|publish/i.test(k) && k !== 'openwikiRefresh');
const ensure = Object.keys(jobs).find((k) => /ensure/i.test(k));
const reclaim = Object.keys(jobs).find((k) => /reclaim/i.test(k));
console.log({ bearer, verify, auditFn, poolFn, aiGet, aiUpsert, refreshStatusFn, retryFn, ensure, reclaim });
console.log('rate', Object.keys(rate), rate.payloadLimits());
console.log('jobs', Object.keys(jobs));
console.log('ai', Object.keys(docmostAi));
console.log('refresh', Object.keys(refresh));

// Fix common mismatches in server source by rewriting require lines exactly
s = s.replace(/require\('\.\/auth\/jwt'\)/, "require('./auth/jwt')");
// Replace identifiers carefully using known actual names
const replacements = [
  ['extractBearer', bearer],
  ['verifyToken', verify],
  ['writeAudit', auditFn],
  ['getPool', poolFn],
  ['docmostAiGet', aiGet],
  ['docmostAiUpsert', aiUpsert],
  ['openwikiRefreshStatus', refreshStatusFn],
  ['openwikiRetryPublish', retryFn],
];
for (const [from, to] of replacements) {
  if (from && to && from !== to) {
    const re = new RegExp('\\\\b' + from + '\\\\b', 'g');
    s = s.replace(re, to);
  }
}
if (ensure) s = s.replace(/jobStore\.ensureSchema/g, 'jobStore.' + ensure);
if (reclaim) s = s.replace(/jobStore\.reclaimStaleRunning/g, 'jobStore.' + reclaim);

// rate limiter method names
s = s.replace(/rateLimiter\.checkUser/g, 'rateLimiter.checkUser');
s = s.replace(/rateLimiter\.checkRefresh/g, 'rateLimiter.checkRefresh');
// if actual methods differ:
const rl = rate.createRateLimiter();
console.log('rl methods', Object.keys(rl));
if (rl.checkUser) s = s.replace(/rateLimiter\.checkUser/g, 'rateLimiter.checkUser');
if (rl.checkRefresh) s = s.replace(/rateLimiter\.checkRefresh/g, 'rateLimiter.checkRefresh');

// limits fields
const lim = rate.payloadLimits();
const bodyKey = Object.keys(lim).find((k) => /body/i.test(k));
const queryKey = Object.keys(lim).find((k) => /query/i.test(k));
const writeKey = Object.keys(lim).find((k) => /write|content/i.test(k));
if (bodyKey) s = s.replace(/limits\.maxBodyBytes/g, 'limits.' + bodyKey);
if (queryKey) s = s.replace(/limits\.maxQueryLen/g, 'limits.' + queryKey);
if (writeKey) s = s.replace(/limits\.maxWriteChars/g, 'limits.' + writeKey);

// sendJson function name consistency
if (s.includes('function sendJson')) s = s.replace(/sendJson\(/g, 'sendJson(');
if (s.includes('function sendJson')) {
  // already sendJson
}

fs.writeFileSync(serverPath, s);
console.log('server patched bytes', s.length);
