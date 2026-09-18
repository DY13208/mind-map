const http = require("http");
const PORT = Number(process.env.IDENTITY_MCP_PORT || 18791);
const hits = [];
function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
async function handleRpc(req, rpc) {
  const sender = String(req.headers["x-requester-sender-id"] || "").trim() || null;
  hits.push({ at: Date.now(), method: rpc.method, sender });
  if (hits.length > 200) hits.splice(0, hits.length - 200);
  if (rpc.method === "initialize") {
    return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "identity-mcp", version: "0.1.0" } };
  }
  if (rpc.method === "notifications/initialized" || rpc.method === "notifications/cancelled") return null;
  if (rpc.method === "tools/list") {
    return { tools: [{ name: "who_am_i", description: "Return requesterSenderId from trusted header", inputSchema: { type: "object", properties: {} } }] };
  }
  if (rpc.method === "tools/call") {
    const name = rpc.params && rpc.params.name;
    if (name !== "who_am_i") return { content: [{ type: "text", text: "unknown tool" }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify({ probe: "identity-mcp-who_am_i", requesterSenderId: sender }) }] };
  }
  if (rpc.method === "ping") return {};
  return { error: { code: -32601, message: "Method not found: " + rpc.method } };
}
const server = http.createServer(async (req, res) => {
  if (req.url === "/health") return sendJson(res, 200, { ok: true, hits: hits.length });
  if (req.url === "/hits") return sendJson(res, 200, { hits: hits.slice(-80) });
  if (req.url === "/hits/reset" && req.method === "POST") { hits.length = 0; return sendJson(res, 200, { ok: true }); }
  if (req.url === "/mcp" || (req.url && req.url.startsWith("/mcp?"))) {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write("event: endpoint\ndata: /mcp\n\n");
      return;
    }
    if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
    try {
      const raw = await readBody(req);
      const rpc = raw ? JSON.parse(raw) : {};
      const result = await handleRpc(req, rpc);
      if (rpc.id === undefined || rpc.id === null) { res.writeHead(202); return res.end(); }
      if (result && result.error && !result.content) return sendJson(res, 200, { jsonrpc: "2.0", id: rpc.id, error: result.error });
      return sendJson(res, 200, { jsonrpc: "2.0", id: rpc.id, result });
    } catch (e) {
      return sendJson(res, 400, { error: String(e.message || e) });
    }
  }
  sendJson(res, 404, { error: "not_found" });
});
server.listen(PORT, "0.0.0.0", () => console.log("[identity-mcp] on", PORT));