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
async function inbound(uid, cid, msg) {
  return gw("/liangce/inbound", {
    method: "POST",
    body: {
      handoff: mint(uid, cid),
      conversationId: cid,
      message: msg,
      messageId: "m-" + Date.now() + "-" + Math.random().toString(16).slice(2),
    },
  });
}

(async () => {
  await gw("/liangce/resolver-log/reset", { method: "POST", body: {} }).catch(() => {});
  try { await fetch("http://127.0.0.1:18791/hits/reset", { method: "POST" }); } catch {}

  const prompt = "Call who_am_i and reply with ONLY the tool JSON.";
  const [A1, A2, B1] = await Promise.all([
    inbound("user-A-test", "conv-cA1", prompt),
    inbound("user-A-test", "conv-cA2", prompt),
    inbound("user-B-test", "conv-cB1", prompt),
  ]);
  const log = await gw("/liangce/resolver-log");
  const status = await gw("/liangce/resolver-status");
  let hits = {};
  try { hits = await (await fetch("http://127.0.0.1:18791/hits")).json(); } catch (e) { hits = { error: String(e.message || e) }; }

  const summary = {
    concurrent: {
      A1: { requester: A1.json.requesterSenderId, reply: A1.json.reply, probe: A1.json.resolverProbe },
      A2: { requester: A2.json.requesterSenderId, reply: A2.json.reply, probe: A2.json.resolverProbe },
      B1: { requester: B1.json.requesterSenderId, reply: B1.json.reply, probe: B1.json.resolverProbe },
      pass:
        A1.json.requesterSenderId === "liangce:user-A-test" &&
        A2.json.requesterSenderId === "liangce:user-A-test" &&
        B1.json.requesterSenderId === "liangce:user-B-test" &&
        /liangce:user-A-test/.test(A1.json.reply || "") &&
        /liangce:user-A-test/.test(A2.json.reply || "") &&
        /liangce:user-B-test/.test(B1.json.reply || ""),
    },
    resolverStatus: status.json,
    resolverLog: log.json,
    mcpHits: hits,
  };
  fs.mkdirSync("integrations/openclaw/phase2b1", { recursive: true });
  fs.writeFileSync("integrations/openclaw/phase2b1/concurrent.json", JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
