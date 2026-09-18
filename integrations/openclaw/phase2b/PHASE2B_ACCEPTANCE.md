# Phase 2B Acceptance Report — Knowledge MCP Read-Only

Date: 2026-09-18  
Verdict: **Phase 2B = PASS**

## 1. Knowledge MCP architecture

```
OpenClaw
├── Memory
│   └── cognee-openclaw   (unchanged slot)
└── Tools
    └── knowledge-mcp (HTTP MCP :18792)
        ├── JWT auth (iss=openclaw-liangce, aud=knowledge-mcp, TTL≈180s)
        ├── Live ACL from Mind Map Postgres room_members
        ├── Canonical adapter (knowledge/<roomId>)
        ├── Docmost adapter (mapping-first via knowledge_docmost_mappings)
        └── OpenWiki adapter (data/openwiki/rooms/<roomId>/wiki only)
```

Requester path:

```
Signed Handoff → liangce-ingress → requesterSenderId=liangce:<userId>
  → registerMcpServerConnectionResolver
  → mint short JWT
  → Knowledge MCP verifies JWT + live room ACL
```

## 2. Files changed / added

- `integrations/knowledge-mcp/**` — new service (server, auth, ACL, adapters, audit, openwiki-runner, Dockerfile)
- `docker-compose.yml` — `knowledge-mcp` service + volume `knowledge-mcp-audit`, `user: "0:0"` for bind-mount readability
- `.env` — `KNOWLEDGE_MCP_JWT_SECRET`, TTL, port
- `scripts/openclaw-docker.js` — explicit `plugins.allow` + `mcp.servers.knowledge-mcp`, remove identity-mcp
- `integrations/openclaw/liangce-ingress/index.js` + `openclaw.plugin.json` — knowledge-mcp resolver JWT mint; identity-mcp demoted
- `scripts/_mint_kmcp.js` — test helper
- `integrations/openclaw/phase2b/PHASE2B_ACCEPTANCE.json` — machine evidence
- `data/openwiki/rooms/**` — room-scoped OpenWiki outputs (test)

## 3. Docker / image

- Image: `mind-map-knowledge-mcp:0.1.0` (COPY sources in Dockerfile; no host source bind for code)
- Runtime mounts: `./knowledge:ro`, `./data/openwiki/rooms:ro`, audit volume
- Health: `http://127.0.0.1:18792/health` → ok, jwtConfigured=true

## 4. Requester-scoped connection

- Resolver registered for `knowledge-mcp`
- No trusted requester → resolver returns null (MCP not materialized)
- JWT minted per requester; not a shared static employee token

## 5. Token contract

Claims: `sub`, `actorType=user`, `iss=openclaw-liangce`, `aud=knowledge-mcp`, `iat`, `exp`, `jti`  
Checks: signature, iss, aud, exp, actorType  
TTL: ~180s  
No full JWT in audit logs

## 6. ACL data source

Live query: `room_members(room_key, user_id, role)` with roles `owner|editor|viewer`  
No second ACL cache as authority

## 7–9. Adapters

- **Canonical**: list/read under `knowledge/<allowedRoomId>` only; path traversal blocked; manifest gated when present
- **Docmost**: mapping-first (`knowledge_docmost_mappings`); no workspace-wide search-then-filter; empty slot → `not_created`
- **OpenWiki**: only `data/openwiki/rooms/<roomId>/wiki`; never global personal wiki; status `not_generated` if missing

## 10. OpenWiki concurrency

- Per-room single-flight + global concurrency limit in `openwiki-runner/lock.js`
- Admin/test CLI only (`openwiki-runner/cli.js`) — **not** exposed as OpenClaw user tool

## 11. Tools (read-only)

`canonical_list`, `canonical_read`, `docmost_search`, `docmost_get`, `openwiki_search`, `openwiki_read`, `openwiki_status`  
No write / refresh user tools

## 12–13. Result / authority

Unified `KnowledgeResult` fields; authorities: formal / formal-mirror / human-supplement / ai-derived

## 14–18. Tests (seeded users)

| Case | Result |
|------|--------|
| User A → only room-2yaz570x | PASS |
| User B → only room-6b5wc9z3 | PASS |
| User C → both rooms | PASS |
| A read B → denied/not_found | PASS |
| Concurrent A/B/C no crosstalk | PASS |
| Invalid token → rejected (`isError`) | PASS |

## 19–20. OpenWiki SECRET + Canonical hash

- room-A wiki contains SECRET_A_MARKER, not SECRET_B_MARKER — PASS
- room-B wiki contains SECRET_B_MARKER, not SECRET_A_MARKER — PASS
- Canonical tree hash unchanged across runner — PASS

## 21–23. Restart / Cognee / plugins.allow

- knowledge-mcp healthy; openclaw-gateway healthy (RestartCount=0 after inject)
- `plugins.slots.memory = cognee-openclaw` unchanged
- Explicit `plugins.allow` includes `liangce-ingress` + `cognee-openclaw` + required builtins; unknown third-party not fail-open
- `mcp.servers` = `knowledge-mcp` only (identity-mcp removed from prod surface)

## 24. Blockers

None for Phase 2B read-only scope.

Residual notes (non-blocking):
- Windows bind-mount ACL required knowledge-mcp `user: "0:0"` for readable `knowledge/` dirs (`drwx------` host dirs)
- Docmost content read depends on `DOCMOST_DATABASE_URL` when page body needed; mapping metadata works without it
- Production still should keep JWT secret only in env / plugin config, not git

## Verdict

**Phase 2B = PASS**

Do not enter Phase 3 (no AI/Docmost/Canonical writes).

Phase 2B 完成，等待 Knowledge MCP 审核。
