const fs = require("fs");
const path = require("path");
const ROOT = "D:/mind-map";
process.chdir(ROOT);
for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1);
  if (!String(process.env[m[1]] || "").trim()) process.env[m[1]] = v.trim();
}
const od = require(path.join(ROOT, "scripts", "openclaw-docker.js"));
const out = od.ensureOpenclawConfig(process.env.OPENCLAW_GATEWAY_TOKEN || "", 4623);
const c = JSON.parse(fs.readFileSync(out, "utf8"));
const summary = {
  memory: c.plugins.slots && c.plugins.slots.memory,
  liangce: !!(c.plugins.entries && c.plugins.entries["liangce-ingress"]),
  secret: !!(c.plugins.entries && c.plugins.entries["liangce-ingress"] && c.plugins.entries["liangce-ingress"].config && c.plugins.entries["liangce-ingress"].config.handoffSecret),
  identityMcp: c.mcp && c.mcp.servers && c.mcp.servers["identity-mcp"] && c.mcp.servers["identity-mcp"].url,
  allow: c.plugins.allow || null,
  pass: (c.plugins.slots && c.plugins.slots.memory === "cognee-openclaw") && !!(c.plugins.entries && c.plugins.entries["liangce-ingress"])
};
fs.mkdirSync(path.join(ROOT, "integrations/openclaw/phase2b1"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "integrations/openclaw/phase2b1/persist-ensure.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));