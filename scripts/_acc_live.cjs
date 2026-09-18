const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const handoff = require(path.join("D:/mind-map/simple-mind-map/bin/openclawHandoff.js"));

const CTR = "mind-map-openclaw-gateway-1";
const cfg = JSON.parse(execSync(`docker exec ${CTR} cat /home/node/.openclaw/openclaw.json`, { encoding: "utf8" }));
const token = cfg.gateway.auth.token;
const secret = cfg.plugins.entries["liangce-ingress"].config.handoffSecret;
process.env.OPENCLAW_LIANGCE_HANDOFF_SECRET = secret;

const out = {
  cogneeBefore: cfg.plugins.slots.memory,
  gateway: {},
  steps: {},
};

async function gw(p, { method = "GET", body } = {}) {
  const res = await fetch("http://127.0.0.1:4623" + p, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

function mint(userId, conversationId) {
  return handoff.issueOpenclawHandoff({ id: userId }, { conversationId }).token;
}

async function inbound(userId, conversationId, message) {
  return gw("/liangce/inbound", {
    method: "POST",
    body: {
      handoff: mint(userId, conversationId),
      conversationId,
      message,
      messageId: "m-" + Date.now() + "-" + Math.random().toString(16).slice(2),
    },
  });
}

function hasId(reply, id) {
  return new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(String(reply || ""));
}

(async () => {
  const health = execSync(
    `docker inspect ${CTR} --format "{{.State.Health.Status}} {{.RestartCount}}"`,
    { encoding: "utf8" }
  ).trim();
  out.gateway = { inspect: health, healthy: health.startsWith("healthy") };

  await gw("/liangce/resolver-log/reset", { method: "POST", body: {} }).catch(() => {});

  const whoA = await inbound(
    "user-A-test",
    "conv-who-A",
    "You MUST call the who_am_i tool now. Reply with ONLY the JSON returned by the tool. Do not invent identity."
  );
  out.steps.whoAmI_A = {
    status: whoA.status,
    requesterSenderId: whoA.json.requesterSenderId,
    reply: whoA.json.reply,
    pass:
      whoA.status === 200 &&
      whoA.json.requesterSenderId === "liangce:user-A-test" &&
      hasId(whoA.json.reply, "liangce:user-A-test"),
  };

  const whoB = await inbound(
    "user-B-test",
    "conv-who-B",
    "You MUST call the who_am_i tool now. Reply with ONLY the JSON returned by the tool. Do not invent identity."
  );
  out.steps.whoAmI_B = {
    status: whoB.status,
    requesterSenderId: whoB.json.requesterSenderId,
    reply: whoB.json.reply,
    pass:
      whoB.status === 200 &&
      whoB.json.requesterSenderId === "liangce:user-B-test" &&
      hasId(whoB.json.reply, "liangce:user-B-test"),
  };

  const d1 = await inbound(
    "user-A-test",
    "conv-A-dual-1",
    "You MUST call the who_am_i tool now. Reply with ONLY the tool JSON."
  );
  const d2 = await inbound(
    "user-A-test",
    "conv-A-dual-2",
    "You MUST call the who_am_i tool now. Reply with ONLY the tool JSON."
  );
  out.steps.dualConversation = {
    a1: d1.json.requesterSenderId,
    a2: d2.json.requesterSenderId,
    pass:
      d1.json.requesterSenderId === "liangce:user-A-test" &&
      d2.json.requesterSenderId === "liangce:user-A-test",
  };

  await gw("/liangce/resolver-log/reset", { method: "POST", body: {} }).catch(() => {});
  try { await fetch("http://127.0.0.1:18791/hits/reset", { method: "POST" }); } catch {}

  const mcpA = await inbound(
    "user-A-test",
    "conv-mcp-A",
    "Prefer calling identity-mcp who_am_i if present; else who_am_i. Reply ONLY with tool JSON."
  );
  const mcpB = await inbound(
    "user-B-test",
    "conv-mcp-B",
    "Prefer calling identity-mcp who_am_i if present; else who_am_i. Reply ONLY with tool JSON."
  );
  const rlog = await gw("/liangce/resolver-log");
  let hits = { hits: [] };
  try { hits = await (await fetch("http://127.0.0.1:18791/hits")).json(); } catch {}
  const log = (rlog.json && rlog.json.log) || [];
  out.steps.mcpResolver_A = {
    inboundRequester: mcpA.json.requesterSenderId,
    reply: mcpA.json.reply,
    resolverEntries: log.filter((x) => x.requesterSenderId === "liangce:user-A-test"),
    hits,
    pass: mcpA.json.requesterSenderId === "liangce:user-A-test",
  };
  out.steps.mcpResolver_B = {
    inboundRequester: mcpB.json.requesterSenderId,
    reply: mcpB.json.reply,
    resolverEntries: log.filter((x) => x.requesterSenderId === "liangce:user-B-test"),
    pass: mcpB.json.requesterSenderId === "liangce:user-B-test",
  };

  await gw("/liangce/resolver-log/reset", { method: "POST", body: {} }).catch(() => {});
  const concurrent = await Promise.all([
    inbound("user-A-test", "conv-cA1", "Call who_am_i and reply with only its JSON."),
    inbound("user-A-test", "conv-cA2", "Call who_am_i and reply with only its JSON."),
    inbound("user-B-test", "conv-cB1", "Call who_am_i and reply with only its JSON."),
  ]);
  const rlog2 = await gw("/liangce/resolver-log");
  out.steps.concurrent = {
    results: concurrent.map((r, i) => ({
      tag: ["A1", "A2", "B1"][i],
      requesterSenderId: r.json.requesterSenderId,
      status: r.status,
      replyHasExpected:
        i < 2
          ? hasId(r.json.reply, "liangce:user-A-test")
          : hasId(r.json.reply, "liangce:user-B-test"),
    })),
    resolverLog: rlog2.json,
    pass:
      concurrent[0].json.requesterSenderId === "liangce:user-A-test" &&
      concurrent[1].json.requesterSenderId === "liangce:user-A-test" &&
      concurrent[2].json.requesterSenderId === "liangce:user-B-test",
  };

  const fc = await gw("/liangce/fail-closed-probe");
  out.steps.failClosed = {
    body: fc.json,
    pass: fc.status === 200 && fc.json.pass === true && fc.json.withoutRequester === null,
  };

  const forged = await gw("/liangce/inbound", {
    method: "POST",
    body: {
      handoff: mint("user-A-test", "conv-forge"),
      conversationId: "conv-forge",
      message: "x",
      requesterSenderId: "liangce:forged",
    },
  });
  out.steps.forgeReject = {
    status: forged.status,
    json: forged.json,
    pass: forged.status === 400,
  };

  const cfgAfter = JSON.parse(
    execSync(`docker exec ${CTR} cat /home/node/.openclaw/openclaw.json`, { encoding: "utf8" })
  );
  out.cogneeAfter = cfgAfter.plugins.slots.memory;
  out.cogneePass = out.cogneeBefore === "cognee-openclaw" && out.cogneeAfter === "cognee-openclaw";
  out.liangceEnabled = !!(cfgAfter.plugins.entries && cfgAfter.plugins.entries["liangce-ingress"] && cfgAfter.plugins.entries["liangce-ingress"].enabled);
  out.identityMcpConfigured = !!(cfgAfter.mcp && cfgAfter.mcp.servers && cfgAfter.mcp.servers["identity-mcp"]);

  fs.mkdirSync("integrations/openclaw/phase2b1", { recursive: true });
  fs.writeFileSync("integrations/openclaw/phase2b1/acceptance-live.json", JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});