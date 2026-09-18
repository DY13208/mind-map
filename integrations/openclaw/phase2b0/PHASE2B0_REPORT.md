# Phase 2B-0 — Requester Identity Probe Report

Date: 2026-09-18 (Asia/Shanghai)
Scope: identity probe only. No Knowledge MCP / OpenWiki / Cognee / Docmost changes.

## 1. Current OpenClaw real version

- Container: `mind-map-openclaw-gateway-1`
- Image: `openclaw/openclaw:latest` (also tagged `ghcr.io/openclaw/openclaw:latest`)
- Package: **openclaw 2026.9.3** (git `1391f7c`)
- Image created: 2026-09-08
- Config: `/home/node/.openclaw/openclaw.json`
- `plugins.slots.memory = cognee-openclaw` (unchanged before/after this probe)

## 2. User → OpenClaw identity chain (as implemented today)

```
WeCom / Mind Map user
  → collab `/api/auth/me` cookie session
     (fields available: userId, wecomUserId, corpId, name, …)
  → Assistant page (browser)
  → OpenClaw Bridge WS  OR  OpenAI-compat HTTP `/v1/chat/completions`
     Bridge: shared OPENCLAW_GATEWAY_TOKEN
     sessionKey = `main:liangce:${conversationId}`
     HTTP body.user = `conv:${conversationId}`  (client-chosen tag, NOT WeCom id)
  → OpenClaw Gateway (operator/backend client)
  → Agent turn
```

**Break:** enterprise identity stops at Mind Map session. Bridge/HTTP never forward `wecomUserId` / `userId` as host-trusted OpenClaw sender.

## 3. Available trusted identity fields (OpenClaw 2026.9.3)

Host-trusted (from SDK/docs/dist — not LLM args):

| Field | Meaning |
|-------|---------|
| `requesterSenderId` | Host-trusted inbound sender id |
| `senderId` / channel `ctx.senderId` | Channel-scoped sender (Feishu open_id, Discord, …) |
| `gatewayClientSenderFields(client)` | From `authenticatedUserProfile` / `authenticatedUserId` / internal senderAttribution |
| MCP resolver ctx | `requesterSenderId`, optional `agentAccountId`, `messageChannel` |

**Not trusted:** any model-produced `{ "userId": "…" }` JSON.

## 4. requesterSenderId / equivalent — measured result

| Path | Result |
|------|--------|
| Mind Map Bridge `chat.send` | Uses shared gateway token; `sessionKey` only embeds `conversationId`. No WeCom sender injected. |
| HTTP `/v1/chat/completions` | Session key pattern `agent:main:openai-user:conv:…`. `created_actor_*` / `owner_actor_*` null on sampled openai-user sessions. |
| Control UI / dashboard session | Actor can be `human` / `gateway-owner` (operator), not enterprise employee. |
| Cron | `created_actor_type=system`, session `agent:main:cron:…` |

`gatewayClientSenderFields` only emits sender when client has profile / authenticatedUserId / internal attribution — **not** when Mind Map Bridge connects as anonymous backend token.

## 5. User A test

- Method: HTTP chat with `user=conv:p2b0-userA-<ts>`
- Status: **200**, assistant `ACK_A`
- OpenClaw identity seen: **conversation tag only** (`openai-user:conv:…`), **no** WeCom/Mind Map user id
- Artifact: `integrations/openclaw/phase2b0/live-dual-http.json`

## 6. User B test

- Method: concurrent HTTP chat with `user=conv:p2b0-userB-<ts>`
- Status: **200**, assistant `ACK_B`
- OpenClaw identity seen: separate conversation tag; **same** gateway service credential as A
- **Not** Trusted Identity B vs A at enterprise level

> Note: two real WeCom browser logins were not exercised in this turn; code path proves even if A/B authenticate to Mind Map, Bridge still drops their ids.

## 7. Concurrency isolation

- A and B fired in `Promise.all` → both 200, correct distinct ACK texts
- **Conversation isolation: PASS** (different `user`/`conversationId` → different sessions)
- **Requester identity isolation: FAIL** (both collapse to shared gateway operator credential; no distinct `requesterSenderId`)

## 8. requester-scoped MCP resolver — actually available?

**YES in OpenClaw 2026.9.3 SDK/docs/runtime:**

- API: `api.registerMcpServerConnectionResolver({ serverName, resolve })`
- `ctx.requesterSenderId` is host-trusted
- Docs: runs **without** trusted `requesterSenderId` (cron, subagent, heartbeat, **public gateway**) **never** materialize requester-scoped servers; no shared fallback

**Mind Map integration: NOT wired** — no plugin registers a resolver; Bridge does not supply requesterSenderId.

## 9. who_am_i probe result

- Experimental plugin **authored** at `integrations/openclaw/phase2b0/identity-probe-plugin/` (`who_am_i` tool)
- **Not enabled** on live gateway (would need config entry + restart; avoided to keep Cognee/memory slot untouched)
- Expected result if enabled on current Bridge path: `requesterSenderId: null` for both A and B (matches SDK contract for public gateway / no trusted sender)
- Code evidence already sufficient without hot-load

## 10. Background tasks without requester

| Runner | Behavior |
|--------|----------|
| cron | `system` actor; no employee requesterSenderId |
| heartbeat / subagent | Docs: no trusted requesterSenderId → no requester-scoped MCP |
| Rule | Must **not** inherit a random employee ACL; future service access needs `actorType=service` + explicit grant |

## 11. Native Identity = FAIL

```
NATIVE REQUESTER IDENTITY = FAIL
```

Reasons:

1. OpenClaw **can** do native requester identity + scoped MCP.
2. Current Mind Map → Bridge → Gateway path **does not** provide host-trusted per-employee sender.
3. A/B collapse to one service/gateway identity (shared token), with only conversation-level separation.

## 12. Phase 2B recommended identity scheme

**Primary recommendation (after FAIL):** Fallback Signed User Context for Phase 2B design (do not implement full fallback this phase):

```
WeCom User
  → Mind Map Session (server-side)
  → Bridge issues short-lived signed user context (userId, wecomUserId, corpId, exp, sig)
  → OpenClaw (verify signature host-side; map into trusted requesterSenderId / senderAttribution)
  → registerMcpServerConnectionResolver
  → short-lived Knowledge MCP credential
  → Knowledge MCP ACL
```

Also keep OpenClaw native path as future optimization **if** Bridge can set host-trusted `requesterSenderId` / `internal.senderAttribution` without LLM involvement.

Clarify:

- OpenClaw requester identity = **identity source**
- Knowledge MCP short-lived token = **downstream credential**
- Do not conflate the two

OpenWiki carry-over (design only): room-scoped wiki output + per-room refresh single-flight + global concurrency limit; never expose whole `/knowledge` to one user scope.

## 13. Files touched / created

Created (probe artifacts only; no Cognee/OpenWiki/Docmost/Knowledge MCP):

- `integrations/openclaw/phase2b0/live-dual-http.json`
- `integrations/openclaw/phase2b0/identity-probe-plugin/*`
- `integrations/openclaw/phase2b0/PHASE2B0_REPORT.md` (this file)
- temp scripts `scripts/_p2b0_*.cjs` / `scripts/_p2b0_*.py` (local probe helpers)

No production Bridge/Assistant identity wiring changes.

## 14. Cognee before/after

| Check | Before | After |
|-------|--------|-------|
| `plugins.slots.memory` | `cognee-openclaw` | `cognee-openclaw` |
| cognee-openclaw enabled | true | true |
| Code/config edits to Cognee | none | none |

## 15. Current blockers

1. Bridge/HTTP path lacks host-trusted employee sender → blocks requester-scoped Knowledge MCP.
2. Real dual WeCom UI login not executed this turn (code-path gap is definitive; UI dual-login optional confirmation later).
3. who_am_i plugin not hot-enabled (restart risk); optional follow-up under controlled restart.

## Verdict

```
Phase 2B-0 = FAIL
Fallback Signed User Context required
```
