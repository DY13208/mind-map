#!/usr/bin/env node
/**
 * 生成跨机访问 Wiki（knowledge-mcp）所需的客户端配置。
 *
 * 在**服务机**上运行，输出可直接粘贴到客户机 WorkBuddy 的 mcp.json 片段。
 *
 *   node scripts/wiki-mcp-lan.js                 # 只打印配置与后续步骤
 *   node scripts/wiki-mcp-lan.js --user dev-local
 *   node scripts/wiki-mcp-lan.js --ttl 604800     # 跨机建议 7–30 天
 *   node scripts/wiki-mcp-lan.js --enable-lan     # 额外把 .env 的绑定改为 0.0.0.0
 *   node scripts/wiki-mcp-lan.js --json           # 机器可读输出
 *
 * 注意：本脚本**不会**自动改防火墙、不会重启容器。防火墙需要管理员权限，
 * 且属于安全变更，命令由脚本打印、由人确认后执行。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.KNOWLEDGE_MCP_PORT || '18792';

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

const env = { ...readEnvFile(path.join(ROOT, '.env')), ...process.env };
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

// --- 局域网 IP 探测（与 scripts/docker-up.js 的 listLanIPs 同一策略） ---
function isVirtualName(name) {
  return /virtual|vmware|vbox|hyper-v|loopback|bluetooth|tap|tun|docker|wsl/i.test(
    name,
  );
}
function scoreIp(address) {
  if (address.startsWith('192.168.')) return 300;
  if (address.startsWith('10.')) return 200;
  const p = address.split('.').map(Number);
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return 100;
  return 0;
}
function listLanIPs() {
  const ifaces = os.networkInterfaces();
  const list = [];
  for (const name of Object.keys(ifaces)) {
    if (isVirtualName(name)) continue;
    for (const addr of ifaces[name] || []) {
      const isV4 = addr.family === 'IPv4' || addr.family === 4;
      if (!isV4 || addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue;
      list.push({ name, address: addr.address });
    }
  }
  list.sort((a, b) => scoreIp(b.address) - scoreIp(a.address));
  return list;
}

const lanIPs = listLanIPs();
const host = flag('--host') || (lanIPs[0] && lanIPs[0].address) || null;

// --- 签发令牌 ---
const secret = env.KNOWLEDGE_MCP_JWT_SECRET;
if (!secret) {
  console.error('缺少 KNOWLEDGE_MCP_JWT_SECRET（应在项目根 .env 中）');
  process.exit(1);
}
const userId = flag('--user') || env.AUTH_DEV_BYPASS_USER_ID || 'dev-local';
function parseJwtTtlSec(raw, defaultTtl = 180) {
  if (raw === undefined || raw === null) return defaultTtl;
  const text = String(raw).trim();
  if (text === '') return defaultTtl;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return defaultTtl;
  return Math.floor(n);
}
const ttlSec = parseJwtTtlSec(
  flag('--ttl') != null ? flag('--ttl') : env.KNOWLEDGE_MCP_JWT_TTL_SEC,
  180
);

const b64 = (v) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
const now = Math.floor(Date.now() / 1000);
const payload = {
  sub: String(userId),
  actorType: 'user',
  iss: env.KNOWLEDGE_MCP_JWT_ISS || 'openclaw-liangce',
  aud: env.KNOWLEDGE_MCP_JWT_AUD || 'knowledge-mcp',
  iat: now,
  jti: crypto.randomUUID(),
};
if (ttlSec > 0) payload.exp = now + ttlSec;
const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
const token = `${data}.${crypto.createHmac('sha256', secret).update(data).digest('base64url')}`;
const expiresAt =
  ttlSec > 0 ? new Date((now + ttlSec) * 1000).toISOString() : null;

// --- 可选：把绑定改为 0.0.0.0 ---
const enableLan = args.includes('--enable-lan');
const envPath = path.join(ROOT, '.env');
let bindChanged = false;
if (enableLan) {
  const raw = fs.readFileSync(envPath, 'utf8');
  if (/^KNOWLEDGE_MCP_BIND\s*=/m.test(raw)) {
    fs.writeFileSync(
      envPath,
      raw.replace(/^KNOWLEDGE_MCP_BIND\s*=.*$/m, 'KNOWLEDGE_MCP_BIND=0.0.0.0'),
      'utf8',
    );
  } else {
    fs.appendFileSync(
      envPath,
      `\nKNOWLEDGE_MCP_BIND=0.0.0.0\n`,
      'utf8',
    );
  }
  bindChanged = true;
}

const lanPrefix = host ? host.split('.').slice(0, 3).join('.') + '.0/24' : '<客户机网段>';
const snippet = {
  'mind-map-wiki': {
    type: 'http',
    url: host ? `http://${host}:${PORT}/mcp` : `http://<服务机IP>:${PORT}/mcp`,
    disabled: false,
    headers: { Authorization: `Bearer ${token}` },
  },
};

if (args.includes('--json')) {
  console.log(
    JSON.stringify(
      { bindChanged, host, lanIPs, snippet, userId, expiresAt },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log('=== 服务机信息 ===');
console.log(`局域网 IP 候选：${lanIPs.map((i) => `${i.address} (${i.name})`).join(', ') || '未探测到'}`);
console.log(`采用地址：${host || '(未探测到，请用 --host 指定)'}`);
console.log(`当前绑定：${env.KNOWLEDGE_MCP_BIND || '127.0.0.1'}` +
  (bindChanged ? '  → 已改为 0.0.0.0' : ''));
console.log('');
console.log('=== 1) 服务机：放开绑定并重建 ===');
if (!bindChanged) {
  console.log('  在 .env 里设 KNOWLEDGE_MCP_BIND=0.0.0.0');
  console.log('  或直接跑：node scripts/wiki-mcp-lan.js --enable-lan');
}
console.log('  然后重建（改端口必须 recreate，restart 无效）：');
console.log('    node scripts/docker-up.js up');
console.log('');
console.log('=== 2) 服务机：放行防火墙（管理员 PowerShell，务必限定来源）===');
console.log(`  New-NetFirewallRule -DisplayName "mind-map knowledge-mcp ${PORT}" \``);
console.log(`    -Direction Inbound -Protocol TCP -LocalPort ${PORT} \``);
console.log(`    -Action Allow -RemoteAddress ${lanPrefix}`);
console.log('');
console.log('=== 3) 服务机：本机自测（应返回 ok:true）===');
console.log(`  curl http://127.0.0.1:${PORT}/health`);
console.log(`  curl http://${host || '<服务机IP>'}:${PORT}/health`);
console.log('');
console.log('=== 4) 客户机：粘进 ~/.workbuddy/mcp.json 的 mcpServers ===');
console.log(JSON.stringify({ mcpServers: snippet }, null, 2));
console.log('');
console.log(
  ttlSec > 0
    ? `令牌：sub=${userId}，${ttlSec}s 后到期（${expiresAt}）。跨机建议 TTL 用 7–30 天。`
    : `令牌：sub=${userId}，永久 Token（无 exp）。`,
);
console.log('客户机粘好后，在「连接器管理 → 自定义连接器」点「信任 / 重新连接」。');
console.log('');
console.log('提醒：不要跨机开放 3040 / 15432 / 16379；令牌是明文 HTTP 上的静态 bearer，');
console.log('      来源务必限定，公网访问请改用 SSH 隧道或 WireGuard/Tailscale。');
