'use strict';

function createRateLimiter({ windowMs = 60000, maxPerUser = 60, maxRefreshPerRoomPerHour = 10 } = {}) {
  const hits = new Map();
  function take(key, max, window) {
    const now = Date.now();
    const cur = hits.get(key);
    if (!cur || cur.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + window });
      return { ok: true, remaining: max - 1 };
    }
    if (cur.count >= max) return { ok: false, remaining: 0, retryAfterMs: cur.resetAt - now };
    cur.count += 1;
    return { ok: true, remaining: max - cur.count };
  }
  return {
    checkUser(userId) { return take('u:' + userId, maxPerUser, windowMs); },
    checkRefresh(roomId) { return take('r:' + roomId, maxRefreshPerRoomPerHour, 60 * 60 * 1000); },
    limits: { windowMs, maxPerUser, maxRefreshPerRoomPerHour },
  };
}

function payloadLimits(env = process.env) {
  return {
    maxQueryLen: Number(env.KNOWLEDGE_MCP_MAX_QUERY_LEN || 500),
    maxWriteChars: Number(env.KNOWLEDGE_MCP_MAX_WRITE_CHARS || 200000),
    maxSearchResults: Number(env.KNOWLEDGE_MCP_MAX_SEARCH_RESULTS || 50),
    maxBodyBytes: Number(env.KNOWLEDGE_MCP_MAX_BODY_BYTES || 1000000),
  };
}

module.exports = { createRateLimiter, payloadLimits };
