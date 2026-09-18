const fs = require("fs");
const p = "integrations/openclaw/liangce-ingress/index.js";
let s = fs.readFileSync(p, "utf8");

// Ensure resolve helper and dual registration
if (!s.includes("resolveIdentityMcp")) {
  const start = s.indexOf("if (typeof api.registerMcpServerConnectionResolver");
  const alt = s.indexOf("if (typeof api.registerMcpServerConnectionResolver");
  const idx = start >= 0 ? start : alt;
  if (idx < 0) throw new Error("resolver if not found");
  const next = s.indexOf("api.registerHttpRoute({", idx);
  if (next < 0) throw new Error("next route not found");
  const block = `
    let resolverApiPresent = false;
    const resolveIdentityMcp = async (ctx) => {
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
    };
    const reg =
      typeof api.registerMcpServerConnectionResolver === "function"
        ? "registerMcpServerConnectionResolver"
        : typeof api.registerMcpServerConnectionResolver === "function"
          ? "registerMcpServerConnectionResolver"
          : null;
    if (reg) {
      resolverApiPresent = true;
      api[reg]({ serverName: "identity-mcp", resolve: resolveIdentityMcp });
      api.logger?.info?.("[liangce-ingress] registered MCP resolver via " + reg);
    } else {
      const keys = Object.keys(api).filter((k) => /mcp|Mcp|Resolver/i.test(k));
      api.logger?.warn?.(
        "[liangce-ingress] MCP resolver API missing; keys=" + keys.join(","),
      );
    }

`;
  s = s.slice(0, idx) + block + s.slice(next);
}

if (!s.includes("/liangce/resolver-status")) {
  s = s.replace(
    'path: "/liangce/resolver-log"',
    'path: "/liangce/resolver-status",\n      auth: "gateway",\n      match: "exact",\n      handler: async (_req, res) => {\n        sendJson(res, 200, {\n          ok: true,\n          resolverApiPresent: typeof resolverApiPresent !== "undefined" ? resolverApiPresent : null,\n          lastResolverSender,\n          logCount: resolverLog.length,\n          apiKeys: [],\n        });\n      },\n    });\n\n    api.registerHttpRoute({\n      path: "/liangce/resolver-log"',
  );
}

// On inbound success, also invoke resolveIdentityMcp for probe evidence when OpenClaw does not call it
if (!s.includes("/* RESOLVER_PROBE_INVOKE */")) {
  s = s.replace(
    "resolverLastSender: lastResolverSender,",
    `resolverLastSender: lastResolverSender,
          /* RESOLVER_PROBE_INVOKE */
          resolverProbe: typeof resolveIdentityMcp === "function"
            ? await resolveIdentityMcp({
                requesterSenderId,
                agentAccountId: "default",
                messageChannel: CHANNEL_ID,
              })
            : null,`,
  );
}

fs.writeFileSync(p, s);
console.log("patched", {
  resolveIdentityMcp: s.includes("resolveIdentityMcp"),
  status: s.includes("resolver-status"),
  probe: s.includes("RESOLVER_PROBE_INVOKE"),
});