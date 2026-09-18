# Phase 2B-1 Final Acceptance Report

Date: 2026-09-18 (Asia/Shanghai)
Scope: Trusted Identity Bridge only — **no** formal Knowledge MCP / Canonical / Docmost MCP / OpenWiki MCP / Phase 3 AI writes.
Hard rule: `plugins.slots.memory` remains `cognee-openclaw` (Cognee untouched as memory provider).

## Verdict

**Phase 2B-1 = PASS**
**READY FOR PHASE 2B**

---

## 14-item checklist

| # | Item | Result | Evidence |
|---|------|--------|----------|
| 1 | Gateway healthy, not in recreate loop | **PASS** | `docker inspect` → `healthy`, `RestartCount=0` after compose restart + config inject |
| 2 | Log shows `[liangce-ingress] ready` | **PASS** | Gateway logs: `[liangce-ingress] ready (minimal)` + MCP resolver registered |
| 3 | Cognee still loads; memory slot = `cognee-openclaw` | **PASS** | Config `plugins.slots.memory=cognee-openclaw`; logs `cognee-openclaw: v2026.9.2 loaded`; memory-core skipped for slot |
| 4 | Signed Handoff → Liangce ingress → Agent Turn `who_am_i` (User A) | **PASS** | `requesterSenderId=liangce:user-A-test` + tool JSON same id |
| 5 | Same path User B | **PASS** | `liangce:user-B-test` |
| 6 | Same user, two conversations → same stable id | **PASS** | Both conversations → `liangce:user-A-test` |
| 7 | Not HTTP-body-only identity | **PASS** | Agent called plugin `who_am_i` on real turn; forge body identity rejected |
| 8 | Forge / client-supplied identity rejected | **PASS** | HTTP 400 `identity_forge_rejected` / client-supplied identity fields not accepted |
| 9 | Fail-closed without requester | **PASS** | `withoutRequester=null`, `pass=true` |
| 10 | `registerMcpServerConnectionResolver` present & registered | **PASS** | Logs + `/liangce/resolver-status` → `resolverApiPresent: true` |
| 11 | Minimal identity-mcp probe (A/B headers, no cross-talk) | **PASS** | Concurrent run: identity-mcp `/hits` showed `initialize`/`tools/list` with `x-requester-sender-id` for A then B; resolverLog A/A/A/B/B |
| 12 | Concurrent A1/A2/B1 who_am_i | **PASS** | `integrations/openclaw/phase2b1/concurrent.json` → `pass: true` |
| 13 | `docker compose restart openclaw-gateway` survives | **PASS** | After restart: healthy\|0, liangce ready, Cognee loaded |
| 14 | `scripts/openclaw-docker.js` / Start-Docker path does not wipe Liangce + Cognee slot | **PASS** | LIANGCE_INGRESS_PERSIST + COGNEE slot guard + load `.env` COGNEE_*; `ensureOpenclawConfig` keeps liangce entry/secret/load.paths, identity-mcp URL, `slots.memory=cognee-openclaw` (see `persist-ensure.json`) |

---

## Root cause fixed (gateway recreate)

1. Narrow `plugins.allow` (only 3 plugins) interfered with stock plugins / health → **removed tiny allowlist** (fail-open; entries still enable Liangce/Cognee).
2. Watchdog / docker-up `compose rm -sf` on health flake amplified recreate → stopped loopers during repair; gateway now stable with RestartCount=0.
3. `openclaw-docker.js` previously cleared Cognee memory slot when `COGNEE_ENABLED` was not in `process.env` (only in `.env`) → **fixed**: load COGNEE_* from `.env`; never wipe slot when plugin files exist on volume.

## Identity contract (frozen for Phase 2B)

- Format: `liangce:<mindMapUserId>` (stable across conversations)
- Handoff: ISS=`mind-map`, AUD=`openclaw-liangce`, TYP=`openclaw_identity_handoff`
- Transport: Mind Map Signed Handoff → Bridge (gateway token only) → `POST /liangce/inbound` verify → Agent Turn
- MCP resolver returns same identity-mcp URL with header `x-requester-sender-id`

## Residuals (non-blocking)

1. Plugin trust warning (“can't verify where this plugin came from”) — non-fatal; allow/load.paths enable load.
2. Cognee tool name conflicts (`memory_search` / `memory_get`) — pre-existing; Cognee still loads and recalls.
3. MCP resolver evidence on agent turns used ingress-side `resolveIdentityMcp` probe invoke + real HTTP hits to identity-mcp with per-user headers. OpenClaw core API `registerMcpServerConnectionResolver` is registered; formal Knowledge MCP materialization is **out of scope** for 2B-1.
4. Optional: harden watchdog so transient unhealthy does not `rm -sf` the gateway.

## Artifacts

- `integrations/openclaw/phase2b1/concurrent.json`
- `integrations/openclaw/phase2b1/persist-ensure.json`
- `integrations/openclaw/phase2b1/ACCEPTANCE-REPORT.md` (this file)
- Plugin: `integrations/openclaw/liangce-ingress/`
- Probe MCP: `integrations/openclaw/identity-mcp/` (host :18791)
- Persist patch: `scripts/openclaw-docker.js` (`LIANGCE_INGRESS_PERSIST`, `LIANGCE_COGNEE_SLOT_GUARD`, `LIANGCE_LOAD_COGNEE_ENV`)

## Stop line

Do **not** start formal Phase 2B Knowledge MCP until product owner explicitly opens it.