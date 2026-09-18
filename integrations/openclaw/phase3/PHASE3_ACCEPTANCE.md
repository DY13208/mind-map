# Phase 3 Acceptance Report — AI Restricted Write + OpenWiki Refresh

Date: 2026-09-18  
Verdict: **Phase 3 = PASS**

## 1. Phase 3 architecture

```
OpenClaw
├── Memory
│   └── cognee-openclaw   (UNCHANGED)
└── Tools
    └── knowledge-mcp (:18792)
        ├── JWT auth (iss=openclaw-liangce, aud=knowledge-mcp)
        ├── Live ACL room_members (owner|editor|viewer)
        ├── Read tools (Phase 2B frozen)
        ├── docmost_ai_get / docmost_ai_upsert
        │     requester → ACL write → mapping resolve → ownership guard → Docmost API → audit
        └── openwiki_refresh / openwiki_refresh_status
              requester → ACL refresh → enqueue job → per-room single-flight → CLI → publish AI only
```

AI Write Allowlist: `owner=ai` + `slot=ai` only. Canonical / standard / human remain forbidden.

## 2. Files changed / added

- `integrations/knowledge-mcp/src/acl/rooms.js` — assertCanWrite / assertCanRefresh
- `integrations/knowledge-mcp/src/adapters/docmostWriteClient.js` — Docmost sync auth + create/update
- `integrations/knowledge-mcp/src/adapters/docmostAi.js` — AI get/upsert, lazy create, ownership guard
- `integrations/knowledge-mcp/src/adapters/openwikiRefresh.js` — async jobs, coalesce, publish-to-ai
- `integrations/knowledge-mcp/src/server.js` — register Phase 3 tools (v0.3.0)
- `integrations/knowledge-mcp/src/audit/log.js` — richer write/refresh audit fields
- `docker-compose.yml` — Docmost write env, openwiki rooms/jobs rw mounts, image 0.3.0
- `.env` — DOCMOST_APP_SECRET / DOCMOST_DATABASE_URL / DOCMOST_INTERNAL_URL
- `integrations/openclaw/phase3/run_acceptance.js`
- `integrations/openclaw/phase3/PHASE3_ACCEPTANCE.json`
- `integrations/openclaw/phase3/PHASE3_ACCEPTANCE.md` (this file)

## 3. AI write tools

| Tool | Purpose |
|------|---------|
| `docmost_ai_get` | Read AI slot by roomId+topicKey (server resolves mapping) |
| `docmost_ai_upsert` | Create/replace AI page; ignores client owner/slot/pageId as authority |

No generic `docmost_update(pageId, body)`.

## 4. AI slot lazy creation

First upsert when ai mapping missing:
1. ACL write check
2. Resolve `docmost_space_id` from room standard/human mapping
3. Create Docmost page titled topic · AI 整理 (or optionalTitle)
4. Insert mapping `slot=ai, owner=ai` with UNIQUE(room_id, topic_key, slot)
5. Never title-search for pageId

## 5. Ownership guard

Before every update: mapping must have `slot=ai`, `owner=ai`, active, matching room/topic.  
Pollution (e.g. owner=human on ai slot) → refuse, audit, **no auto-fix**.

## 6. OpenWiki refresh job

- `openwiki_refresh` → `{ jobId, status: queued|running, coalesced? }`
- Background: queued → running → succeeded|partial|failed
- Separates openwikiStatus vs docmostPublishStatus

## 7. Refresh ACL

- viewer → DENY refresh / AI write
- editor / owner → ALLOW refresh + AI write
- Uses live `room_members` (no second ACL)

## 8. Per-room / global concurrency

- Reuses `openwiki-runner/lock.js` per-room single-flight + global concurrency
- Same-room refresh ×5 coalesces to one `jobId`

## 9. OpenWiki → AI Docmost publish

On refresh success, each wiki `.md` publishes only to AI slot with `topicKey=openwiki:<path>`.  
Never writes standard / human / Canonical.

## 10–16. Acceptance tests (automated)

Evidence: `PHASE3_ACCEPTANCE.json` — **14/14 PASS**

| # | Case | Result |
|---|------|--------|
| 10 | User A upsert room-A | PASS |
| 10 | User A upsert room-B | DENY |
| 10 | User B upsert room-B | PASS |
| 10 | User B upsert room-A | DENY |
| 11–12 | standard/human hashes unchanged when AI upserts same topicKey | PASS |
| 13 | Polluted ai mapping owner=human → DENY | PASS |
| 14 | viewer refresh DENY; editor refresh PASS | PASS |
| 15 | room-A refresh ×5 → single jobId | PASS |
| 16 | refresh → AI pages published | PASS |

## 17. Canonical hash

OpenWiki CLI still verifies canonical tree hash unchanged before/after snapshot (Phase 2B runner preserved). Refresh E2E succeeded without Canonical mutation path.

## 18. Docmost failure

Write client fails closed with `docmost_write_failed` / `docmost_unavailable` (no pretend success). Refresh distinguishes openwiki generated vs docmost publish failed.

## 19. Audit

Write/refresh audit fields: requestId, requesterUserId, tool, roomId, topicKey, operation, targetSlot, docmostPageId, beforeHash, afterHash, jobId, status, durationMs. No JWT bodies logged.

## 20. Retry / idempotency

UNIQUE(room_id, topic_key, slot) prevents duplicate AI pages on retry. Refresh coalesce returns existing jobId.

## 21. Cognee before/after

OpenClaw Cognee memory slot was not modified in Phase 3. Only knowledge-mcp was rebuilt. See check script output in acceptance package.

## 22. Phase 2B test data cleanup

- No SECRET_A/B_MARKER files found under `data/openwiki` at report time
- Phase 3 test users (`phase3-user-a/b`, `phase3-viewer`) retained for retest; can drop after review
- Formal evidence kept under `integrations/openclaw/phase2b/` and `phase3/`

## 23. Current blockers

None for Phase 3 scope.

Residual (Phase 4 mandatory hardening — not done now):
- knowledge-mcp still `user: "0:0"` for Windows volume readability
- Do not enter Phase 4 until AI Write review completes

## Verdict

**Phase 3 = PASS**

Phase 3 完成，等待 AI Write 审核。
