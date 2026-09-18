const fs = require("fs");
const { execSync } = require("child_process");
const handoff = require("D:/mind-map/simple-mind-map/bin/openclawHandoff.js");
const CTR = "mind-map-openclaw-gateway-1";
const cfg = JSON.parse(execSync(`docker exec ${CTR} cat /home/node/.openclaw/openclaw.json`, { encoding: "utf8" }));
const token = cfg.gateway.auth.token;
process.env.OPENCLAW_LIANGCE_HANDOFF_SECRET = cfg.plugins.entries["liangce-ingress"].config.handoffSecret;

async function gw(path, opts = {}) {
  const res = await fetch("http://127.0.0.1:4623" + path, {
    method: opts.method || "GET",
    headers: {
      Authorization: "Bearer " + token,
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}
function mint(uid, cid) {
  return handoff.issueOpenclawHandoff({ id: uid }, { conversationId: cid }).token;
}

(async () => {
  const prompt = "Call who_am_i and reply with ONLY the tool JSON.";
  const A = await gw("/liangce/inbound", { method: "POST", body: { handoff: mint("user-A-test","conv-final-A"), conversationId: "conv-final-A", message: prompt, messageId: "mf-a" } });
  const B = await gw("/liangce/inbound", { method: "POST", body: { handoff: mint("user-B-test","conv-final-B"), conversationId: "conv-final-B", message: prompt, messageId: "mf-b" } });
  const forge = await gw("/liangce/inbound", { method: "POST", body: { handoff: mint("user-A-test","conv-forge"), conversationId: "conv-forge", message: prompt, messageId: "mf-f", requesterSenderId: "liangce:forged" } });
  // fail-closed probe endpoint if present
  let failClosed = null;
  try {
    failClosed = await gw("/liangce/fail-closed-probe", { method: "POST", body: {} });
  } catch (e) {
    failClosed = { error: String(e.message || e) };
  }
  // without handoff
  const noHandoff = await gw("/liangce/inbound", { method: "POST", body: { conversationId: "x", message: "hi", messageId: "n" } });
  const status = await gw("/liangce/resolver-status");
  const health = String(execSync(`docker inspect ${CTR} --format "{{.State.Health.Status}}|{{.RestartCount}}"`, { encoding: "utf8" })).trim();
  const out = {
    health,
    memorySlot: cfg.plugins.slots && cfg.plugins.slots.memory,
    A: { status: A.status, requester: A.json.requesterSenderId, replyHas: /liangce:user-A-test/.test(A.json.reply || "") },
    B: { status: B.status, requester: B.json.requesterSenderId, replyHas: /liangce:user-B-test/.test(B.json.reply || "") },
    forge: { status: forge.status, code: forge.json && (forge.json.error || forge.json.code || forge.json.raw) },
    noHandoff: { status: noHandoff.status, body: noHandoff.json },
    failClosed: failClosed && failClosed.json ? failClosed.json : failClosed,
    resolverStatus: status.json,
  };
  fs.mkdirSync("integrations/openclaw/phase2b1", { recursive: true });
  fs.writeFileSync("integrations/openclaw/phase2b1/final-mini.json", JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });