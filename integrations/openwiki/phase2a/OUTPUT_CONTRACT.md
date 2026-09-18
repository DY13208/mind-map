# Phase 2A — OpenWiki 0.5.2 Output Contract

**Status:** PASS (with caveats)  
**Date:** 2026-09-18 (Asia/Shanghai)  
**Scope:** OpenWiki 0.5.2 only. No 2B-0 / Knowledge MCP / OpenClaw / AI Docmost / Cognee changes.

---

## 1. What OpenWiki is (in this repo)

OpenWiki 0.5.2 is an **LLM wiki generation / ingest engine**, not a Docmost-like page server.

- Image: `mind-map-openwiki:0.5.2`
- CLI entry: `/usr/local/bin/openwiki` → `.../openwiki/dist/cli/cli.js`
- Entrypoint: `setup.cjs` → loopback `proxy.cjs` → `openwiki "$@"`
- Personal home: volume `openwiki-state` → `/data/openwiki`
- Canonical mount: `./knowledge:/knowledge:ro`
- Adapter today: `simple-mind-map/bin/knowledge/adapters/openwikiAdapter.js` — **health-only**, `syncImplemented: false`, `runtime: on_demand_cli`

## 2. How we invoke it (verified)

```text
docker compose -f docker-compose.yml -f docker-compose.wiki.yml --profile wiki-runtime \
  run --rm --no-deps openwiki-runtime personal --update --print "<prompt>"
```

Gotchas:

- Bare `openwiki --update` defaults to **code mode**; always use `personal` or `--mode personal`.
- Non-TTY requires `--print` / `-p` (Ink raw-mode otherwise).
- Mind Map MCP (`custom-mcp` → `127.0.0.1:3848`) needs `app` up.
- Canonical path works via `/knowledge:ro` (agent often used **shell read** because `custom-mcp-canonical` tools were **not** reliably in `tools/list`).

## 3. Inputs

| Input | Location | Notes |
|-------|----------|-------|
| Canonical rooms | Host `knowledge/<roomId>/` → `/knowledge` RO | `manifest.json` + documents |
| OpenWiki home | `/data/openwiki` | `.env`, `onboarding.json`, `INSTRUCTIONS.md`, connectors |
| LLM | DeepSeek via openai-compatible in `/data/openwiki/.env` | Verified live |
| Optional Mind Map MCP | `connectors/custom-mcp` + proxy | Test rooms **not** in Mind Map inventory |

Fixtures used: `ow-p2a-room-a`, `ow-p2a-room-b`.

## 4. Outputs

| Output | Location | Durable? |
|--------|----------|----------|
| Personal wiki Markdown | `/data/openwiki/wiki/**/*.md` | Yes (volume) |
| Update metadata | `/data/openwiki/wiki/.last-update.json` (also observed as `.last-update.json`) | Yes |
| Connector raw dumps | `/data/openwiki/connectors/*/raw/` (when MCP used) | Yes |
| `--print` assistant summary | stdout / logs | Ephemeral |
| Code-mode `.page-manifest.json` / `.run.json` | N/A in personal mode | Not produced |

Exported copies: `integrations/openwiki/phase2a/artifacts/wiki-ingest{1,2-noop,3-edit,4-delete}/`

## 5. Durable state map

```
/data/openwiki/
  .env, onboarding.json, INSTRUCTIONS.md
  connectors/custom-mcp/
  connectors/custom-mcp-canonical/   # config present; tools often not discovered by agent
  wiki/                              # SoT for generated pages
  conversation_history/, skills/
```

Canonical SoT remains host `knowledge/` (compose `:ro`).

## 6. Case results

| Case | Result | Evidence |
|------|--------|----------|
| First LLM ingest | **PASS** | Pages: quickstart, rooms/*, topics/hiring-sop, sources/*, open-questions; `generated: openwiki/0.5.2` |
| Durable artifacts | **PASS** | Volume + `artifacts/wiki-ingest1-vol/` |
| No-change re-run | **PASS (soft)** | Content hashes identical; only `.last-update.json` changed (`noop-diff.json`) |
| Canonical edit refresh | **PASS** | After appending `P2A_EDIT_MARKER_room-a-refresh-test`, wiki room-a + hiring-sop updated |
| Topic delete | **PASS** | Removed `branches/hiring-sop.md` + manifest entry; wiki recorded deletion; room-b still sole publisher |
| Room isolation | **FAIL by design** | Single personal wiki; both rooms mixed into one tree (`rooms/a`, `rooms/b`) — **no native room namespace** |
| Concurrency | **UNSAFE (observed soft)** | Parallel A/B both Completed; both chose no-edit; **no CLI lockfile** — races possible on content writes |
| Canonical RO (untouched) | **PASS** | `roomB_unchanged: true` in `canonical-ro-check.json`; compose `:ro` |
| Canonical RO (intentional host edits) | Expected change on room-a only | Host-side edit/delete for tests |
| Cognee / Phase1 zero-touch | **PASS** | No dirty paths matching cognee / docmost / Coordinator |
| openwikiAdapter health-only | **PASS** | `syncImplemented: false` |

## 7. Refresh semantics

- Trigger: `personal --update --print` or `ingest <target> --print`
- Mechanism: LLM synthesizes from connector evidence + (fallback) shell reads of `/knowledge`
- No-change: **agent-prompt soft noop** (not hard git noop of code mode). Metadata file may still refresh.
- After Canonical edit/delete: next update **can** converge wiki claims (verified once each).

## 8. Room isolation model

**None at OpenWiki layer.** One personal brain under `/data/openwiki/wiki`. Multi-room = mixed wiki unless Phase 2B wraps **per-room config dirs** or filters via Knowledge MCP.

## 9. Concurrency model

**Best-effort / unsafe** for parallel CLI runs. No durable cross-process lock in OpenWiki 0.5.2 personal path. Phase 2B must add single-flight (similar spirit to Docmost `docmostSyncCoordinator`).

## 10. Canonical read-only guarantee

- Compose `:ro` + Canonical MCP tools are read-only (`list_knowledge` / `read_knowledge`).
- Live hash: room-b unchanged across all OpenWiki runs.
- Host intentionally mutated room-a for edit/delete cases; restored afterward for fixtures.

## 11. Connector discovery caveat (important)

`custom-mcp-canonical` config is seeded, but the agent often **did not** get `list_knowledge`/`read_knowledge` in `tools/list` (one run failed with exact tool-name error). Successful runs used **shell** against `/knowledge`. Phase 2B must treat Canonical MCP registration as a hard prerequisite, not assume discovery.

## 12. Role for Phase 2B (do not implement now)

1. Orchestrate on-demand CLI (`personal --update` / `ingest`) behind Knowledge MCP.
2. Expose **read** APIs over generated wiki Markdown.
3. Enforce **per-room scope** (separate homes or filtered prompts).
4. Add **single-flight / locking**.
5. Keep Canonical RO; never write Docmost AI slots here without Phase 3.
6. Keep Cognee `plugins.slots.memory` untouched.
7. Fix Canonical MCP tool discovery before relying on it in automation.

## 13. Artifact index

Under `integrations/openwiki/phase2a/artifacts/`:

- `ingest-1.log` … `ingest-4-delete.log`
- `wiki-ingest1-vol/`, `wiki-ingest2-noop/`, `wiki-ingest3-edit/`, `wiki-ingest4-delete/`
- `wiki-hash-ingest1.json`, `wiki-hash-ingest2-noop.json`, `noop-diff.json`
- `canonical-hash-pre-ingest.json`, `canonical-hash-post.json`, `canonical-ro-check.json`
- `concurrency-A.log`, `concurrency-B.log`, `concurrency-summary.txt`

## 14–20. Contract checklist (for approval)

14. Input contract documented — **YES**  
15. Output / durable paths documented — **YES**  
16. Refresh semantics documented — **YES**  
17. Room isolation documented (none) — **YES**  
18. Concurrency documented (unsafe) — **YES**  
19. Canonical RO proven for untouched room — **YES**  
20. Adapter remains health-only; 2B role clear — **YES**

**Overall:** Phase 2A Output Contract is ready for review. Live LLM ingest **succeeded**.

