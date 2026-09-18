const fs = require("fs");
const p = "integrations/openclaw/liangce-ingress/index.js";
let s = fs.readFileSync(p, "utf8");
console.log("before len", s.length);
if (!s.includes("const resolverLog")) {
  if (s.includes("let lastResolverSender = null;")) {
    s = s.replace(
      "let lastResolverSender = null;",
      "let lastResolverSender = null;\nconst resolverLog = [];\nfunction pushResolver(entry) {\n  resolverLog.push({ ...entry, at: Date.now() });\n  if (resolverLog.length > 200) resolverLog.splice(0, resolverLog.length - 200);\n}"
    );
  } else if (s.includes("let lastResolverSender = null;")) {
    s = s.replace(
      "let lastResolverSender = null;",
      "let lastResolverSender = null;\nconst resolverLog = [];\nfunction pushResolver(entry) {\n  resolverLog.push({ ...entry, at: Date.now() });\n  if (resolverLog.length > 200) resolverLog.splice(0, resolverLog.length - 200);\n}"
    );
  } else {
    // container uses lastResolverSender
    s = s.replace(
      "let lastResolverSender = null;",
      "let lastResolverSender = null;\nconst resolverLog = [];\nfunction pushResolver(entry) {\n  resolverLog.push({ ...entry, at: Date.now() });\n  if (resolverLog.length > 200) resolverLog.splice(0, resolverLog.length - 200);\n}"
    );
  }
}
const resolverImpl = `api.registerMcpServerConnectionResolver({
        serverName: "identity-mcp",
        resolve: async (ctx) => {
          const sender = String(ctx?.requesterSenderId || "").trim();
          pushResolver({
            requesterSenderId: sender || null,
            agentAccountId: ctx?.agentAccountId ?? null,
            messageChannel: ctx?.messageChannel ?? null,
          });
          if (!sender) {
            lastResolverSender = null;
            return null;
          }
          lastResolverSender = sender;
          return {
            url: "http://host.docker.internal:18791/mcp",
            headers: { "x-requester-sender-id": sender },
          };
        },
      });`;
if (/api\.registerMcpServerConnectionResolver\(\{[\s\S]*?\}\);/.test(s)) {
  s = s.replace(/api\.registerMcpServerConnectionResolver\(\{[\s\S]*?\}\);/, resolverImpl);
} else if (/api\.registerMcpServerConnectionResolver\(\{[\s\S]*?\}\);/.test(s)) {
  s = s.replace(/api\.registerMcpServerConnectionResolver\(\{[\s\S]*?\}\);/, resolverImpl.replace(/registerMcpServerConnectionResolver/g, "registerMcpServerConnectionResolver"));
} else {
  console.log("NO resolver call found");
}
if (!s.includes("/liangce/resolver-log")) {
  const route = `api.registerHttpRoute({
      path: "/liangce/resolver-log",
      auth: "gateway",
      match: "exact",
      handler: async (_req, res) => {
        sendJson(res, 200, { ok: true, log: resolverLog.slice(-80) });
      },
    });

    api.registerHttpRoute({
      path: "/liangce/resolver-log/reset",
      auth: "gateway",
      match: "exact",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method_not_allowed" });
          return;
        }
        resolverLog.length = 0;
        lastResolverSender = null;
        sendJson(res, 200, { ok: true });
      },
    });

    `;
  if (s.includes('path: "/liangce/fail-closed-probe"')) {
    s = s.replace('api.registerHttpRoute({\n      path: "/liangce/fail-closed-probe"', route + 'api.registerHttpRoute({\n      path: "/liangce/fail-closed-probe"');
  } else if (s.includes("path: \"/liangce/fail-closed-probe\"")) {
    s = s.replace('api.registerHttpRoute({\r\n      path: "/liangce/fail-closed-probe"', route.replace(/\n/g,"\r\n") + 'api.registerHttpRoute({\r\n      path: "/liangce/fail-closed-probe"');
  }
}
s = s.replace("{ optional: true }", '{ name: "who_am_i" }');
// Align lastResolverSender naming with file
if (s.includes("lastResolverSender") && s.includes("lastResolverSender = null") === false && s.includes("let lastResolverSender")) {
  // noop
}
if (s.includes("let lastResolverSender") && !s.includes("lastResolverSender = sender")) {
  // ensure assignment variable matches
}
fs.writeFileSync(p, s);
console.log("after includes", {
  identity: s.includes("identity-mcp"),
  log: s.includes("resolver-log"),
  who: s.includes('name: "who_am_i"'),
  push: s.includes("pushResolver"),
  api: (s.match(/registerMcpServerConnectionResolver/g) || []).length,
});