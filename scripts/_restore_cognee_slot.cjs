const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);
const envText = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
for (const line of envText.split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  v = v.trim();
  if (!String(process.env[m[1]] || "").trim()) process.env[m[1]] = v;
}
console.log("COGNEE_ENABLED=", JSON.stringify(process.env.COGNEE_ENABLED));
const od = require(path.join(ROOT, "scripts", "openclaw-docker.js"));
const token = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const out = od.ensureOpenclawConfig(token || undefined, 4623);
console.log("wrote", out);
const cfg = JSON.parse(fs.readFileSync(out, "utf8"));
console.log(JSON.stringify({
  slots: cfg.plugins && cfg.plugins.slots,
  cogneeEnabled: cfg.plugins && cfg.plugins.entries && cfg.plugins.entries["cognee-openclaw"] && cfg.plugins.entries["cognee-openclaw"].enabled,
  liangce: !!(cfg.plugins && cfg.plugins.entries && cfg.plugins.entries["liangce-ingress"]),
  identityMcp: cfg.mcp && cfg.mcp.servers && cfg.mcp.servers["identity-mcp"]
}, null, 2));
const id = "mind-map-openclaw-gateway-1";
const ps = spawnSync("docker", ["inspect", id, "--format", "{{.State.Running}}"], { encoding: "utf8" });
if (String(ps.stdout || "").trim() === "true") {
  const cp = spawnSync("docker", ["cp", out, id + ":/home/node/.openclaw/openclaw.json"], { encoding: "utf8" });
  console.log("docker cp status", cp.status, String(cp.stderr || ""));
  spawnSync("docker", ["exec", id, "sh", "-lc", "chown node:node /home/node/.openclaw/openclaw.json; chmod 600 /home/node/.openclaw/openclaw.json"], { encoding: "utf8" });
  const restart = spawnSync("docker", ["restart", id], { encoding: "utf8" });
  console.log("restart", restart.status, String(restart.stdout || restart.stderr || ""));
} else {
  console.log("container not running; config file only");
}