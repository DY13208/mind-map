const fs = require("fs");
const path = require("path");
const root = path.join("integrations", "knowledge-mcp");
function w(rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content.replace(/\n/g, "\n"), "utf8");
  console.log("wrote", p);
}

w("package.json", JSON.stringify({
  name: "mind-map-knowledge-mcp",
  version: "0.1.0",
  private: true,
  type: "commonjs",
  main: "src/server.js",
  scripts: {
    start: "node src/server.js",
    test: "node --test tests/*.test.js",
    "room-runner": "node src/openwiki-runner/cli.js"
  },
  dependencies: {
    pg: "^8.13.1"
  }
}, null, 2) + "\n");

w("Dockerfile", `# Production image for mind-map-knowledge-mcp — no host source bind mounts required.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
ENV NODE_ENV=production
EXPOSE 18792
USER node
CMD ["node", "src/server.js"]
`);

w("src/utils/paths.js", `'use strict';
const path = require("path");
const fs = require("fs");

function assertSafeRel(rel) {
  const s = String(rel || "").replace(/\\\\/g, "/");
  if (!s || s.startsWith("/") || s.includes("\\0")) {
    const e = new Error("invalid_path");
    e.code = "invalid_path";
    throw e;
  }
  const parts = s.split("/");
  if (parts.some((p) => p === ".." || p === "")) {
    const e = new Error("path_traversal");
    e.code = "path_traversal";
    throw e;
  }
  return parts.join("/");
}

function resolveUnder(rootDir, rel) {
  const safe = assertSafeRel(rel);
  const root = path.resolve(rootDir);
  const full = path.resolve(root, safe);
  if (full !== root && !full.startsWith(root + path.sep)) {
    const e = new Error("path_escape");
    e.code = "path_escape";
    throw e;
  }
  return full;
}

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

module.exports = { assertSafeRel, resolveUnder, fileExists, dirExists };
`);

w("src/utils/result.js", `'use strict';
function knowledgeResult(partial) {
  return {
    source: partial.source ?? null,
    authority: partial.authority ?? null,
    roomId: partial.roomId ?? null,
    topicKey: partial.topicKey ?? null,
    title: partial.title ?? null,
    uri: partial.uri ?? null,
    snippet: partial.snippet ?? null,
    body: partial.body ?? null,
    version: partial.version ?? null,
    updatedAt: partial.updatedAt ?? null,
    owner: partial.owner ?? null,
    pageType: partial.pageType ?? null,
    derived: partial.derived ?? null,
  };
}

function authorityForDocmostSlot(slot, owner) {
  if (slot === "standard" || owner === "mindmap") return "formal-mirror";
  if (slot === "human" || owner === "human") return "human-supplement";
  if (slot === "ai" || owner === "ai") return "ai-derived";
  return "unknown";
}

module.exports = { knowledgeResult, authorityForDocmostSlot };
`);

w("src/auth/jwt.js", `'use strict';
const crypto = require("crypto");

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}
function b64urlJson(obj) {
  return b64url(JSON.stringify(obj));
}

function signKnowledgeToken({
  userId,
  secret,
  ttlSec = 180,
  iss = "openclaw-liangce",
  aud = "knowledge-mcp",
  actorType = "user",
}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: String(userId),
    actorType,
    iss,
    aud,
    iat: now,
    exp: now + Number(ttlSec),
    jti: crypto.randomUUID(),
  };
  const data = b64urlJson(header) + "." + b64urlJson(payload);
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return { token: data + "." + sig, payload };
}

function verifyKnowledgeToken(token, {
  secret,
  iss = "openclaw-liangce",
  aud = "knowledge-mcp",
  allowedActorTypes = ["user"],
} = {}) {
  const parts = String(token || "").trim().split(".");
  if (parts.length !== 3) {
    const e = new Error("invalid_token");
    e.code = "invalid_token";
    throw e;
  }
  const [h, p, s] = parts;
  const expected = crypto.createHmac("sha256", secret).update(h + "." + p).digest("base64url");
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const e = new Error("bad_signature");
    e.code = "bad_signature";
    throw e;
  }
  const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== iss) { const e = new Error("bad_iss"); e.code = "bad_iss"; throw e; }
  if (payload.aud !== aud) { const e = new Error("bad_aud"); e.code = "bad_aud"; throw e; }
  if (!payload.exp || now > Number(payload.exp)) { const e = new Error("expired"); e.code = "expired"; throw e; }
  if (!payload.iat || Number(payload.iat) > now + 60) { const e = new Error("bad_iat"); e.code = "bad_iat"; throw e; }
  if (!allowedActorTypes.includes(String(payload.actorType || ""))) {
    const e = new Error("bad_actor");
    e.code = "bad_actor";
    throw e;
  }
  const sub = String(payload.sub || "").trim();
  if (!sub) { const e = new Error("missing_sub"); e.code = "missing_sub"; throw e; }
  return payload;
}

function extractBearer(req) {
  const h = String(req.headers.authorization || "");
  const m = h.match(/^Bearer\\s+(.+)$/i);
  if (m) return m[1].trim();
  const x = String(req.headers["x-knowledge-token"] || "").trim();
  return x || null;
}

module.exports = { signKnowledgeToken, verifyKnowledgeToken, extractBearer };
`);

w("src/acl/roomAcl.js", `'use strict';
const { Pool } = require("pg");

const READ_ROLES = new Set(["owner", "editor", "viewer"]);

let pool = null;

function getPool(env = process.env) {
  if (pool) return pool;
  const connectionString = String(env.MIND_MAP_DATABASE_URL || "").trim();
  if (connectionString) {
    pool = new Pool({ connectionString, max: 8 });
  } else {
    pool = new Pool({
      host: env.PGHOST || "postgres",
      port: Number(env.PGPORT || 5432),
      user: env.PGUSER || "postgres",
      password: env.PGPASSWORD || "mindmap",
      database: env.PGDATABASE || "mind_map",
      max: 8,
    });
  }
  return pool;
}

async function listReadableRooms(userId, env = process.env) {
  const db = getPool(env);
  const { rows } = await db.query(
    `select room_key, role
       from room_members
      where user_id = $1
        and role = any($2::text[])
      order by room_key`,
    [String(userId), [...READ_ROLES]]
  );
  return rows.map((r) => ({ roomId: r.room_key, role: r.role }));
}

async function canReadRoom(userId, roomId, env = process.env) {
  const db = getPool(env);
  const { rows } = await db.query(
    `select role from room_members
      where user_id = $1 and room_key = $2
        and role = any($3::text[])
      limit 1`,
    [String(userId), String(roomId), [...READ_ROLES]]
  );
  return rows[0] ? { ok: true, role: rows[0].role } : { ok: false, role: null };
}

async function assertCanRead(userId, roomId, env = process.env) {
  const r = await canReadRoom(userId, roomId, env);
  if (!r.ok) {
    const e = new Error("forbidden_room");
    e.code = "forbidden_room";
    e.status = 404; // fail-closed: do not leak existence
    throw e;
  }
  return r;
}

module.exports = { listReadableRooms, canReadRoom, assertCanRead, getPool, READ_ROLES };
`);

console.log("batch1 done");
