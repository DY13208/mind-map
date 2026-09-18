'use strict';
const fs = require('fs');
const path = require('path');

function writeAudit(entry, env = process.env) {
  const row = {
    ts: new Date().toISOString(),
    requestId: entry.requestId || null,
    requesterUserId: entry.requesterUserId || null,
    tool: entry.tool || null,
    roomId: entry.roomId || null,
    topicKey: entry.topicKey || null,
    operation: entry.operation || null,
    targetSlot: entry.targetSlot || null,
    docmostPageId: entry.docmostPageId || null,
    beforeHash: entry.beforeHash || null,
    afterHash: entry.afterHash || null,
    jobId: entry.jobId || null,
    source: entry.source || null,
    resultCount: entry.resultCount ?? null,
    status: entry.status || null,
    durationMs: entry.durationMs ?? null,
  };
  try {
    const p = String(env.KNOWLEDGE_MCP_AUDIT_LOG || '/data/audit/knowledge-mcp.jsonl');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(row) + '\n', 'utf8');
  } catch (err) {
    console.error('[knowledge-mcp] audit_failed', String(err.message || err));
  }
  return row;
}

module.exports = { writeAudit };