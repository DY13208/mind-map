# Collaboration V2 Core Frozen

| Field | Value |
|---|---|
| Freeze date | 2026-09-04 |
| `COLLABORATION_V2_CORE_FROZEN` | **YES** |
| `COLLAB_V2_FREEZE_P0` | **0** |
| Package | `simple-mind-map@0.14.0-fix.3` |
| Suggested tag | `collab-v2-freeze-20260904` |
| Freeze suite | `npm run test:collab:v2:freeze` (cwd: `simple-mind-map`) |

This checkpoint freezes **Collaboration V2 core**. It does **not** remove V1 / Yjs. History, folders, favorites, recycle bin, and team space are out of scope.

After this date, only a **true P0** (see below) may change V2 core. P1/P2 stay in Backlog.

---

## Operation schema

Canonical write types (`bin/collabV2/protocol.js`):

| Type | Role |
|---|---|
| `node.insert` | Create node (`node.create` alias) |
| `node.update` | Content / style / special-object fields on a business UID |
| `node.move` | Reparent / reorder |
| `node.reorder` | Sibling order |
| `node.delete` | Delete (incl. subtree) |
| `node.restore` | Restore deleted |
| `node.batch` | Chunked ops (`paste` alias); max 1000, chunk 250 |
| `map.meta.update` | Theme / layout / themeConfig (`map.meta`, `map.update` aliases) |
| `map.replace` | Full-tree only with allowlist reason |
| `operation.undo` / `operation.redo` | Inverse replay |

Rules:

- `opId` is UUID; `clientId` required and non-empty.
- Sequential per-client `clientSeq`; send `baseRevision` rebased to last server revision; keep `originalBaseRevision`.
- Tree mutations target **business UID** only.

---

## Tree Authority

**`room_nodes` is the only live tree authority.**

| Store | Role |
|---|---|
| `room_nodes` | Latest tree |
| `rooms.nodes` | Legacy mirror only; not used to choose the live V2 tree |
| Client renderer | Hydrate / apply from V2 events; not authority |

V2 + table initialized: `pickAuthoritativeNodes` returns table. JSON fallback for live V2 is forbidden (`V2_TREE_AUTHORITY_FALLBACK_FORBIDDEN`). Uninitialized V2 rooms may migrate once (`INITIAL_LEGACY_MIGRATION`).

---

## Metadata Authority

**`rooms.metadata`** (theme, `themeConfig`, layout / structure).

Ordinary theme/layout changes are `map.meta.update`, not `map.replace`.

---

## Operation Authority

**`room_operations`** is the operation log / idempotency store.

Apply path: Socket.IO `/collab-v2` → Direct Path applier → `room_nodes` + `room_operations` + metadata as needed.

---

## Full-tree allowlist

`map.replace` / authoritative full-tree `setData` is allowed **only** for:

- `IMPORT`
- `IMPORT_UNDO`
- `VERSION_RESTORE`
- `INITIAL_LEGACY_MIGRATION`
- `AUTHORITATIVE_SNAPSHOT_RECOVERY`

Forbidden as full-tree triggers: text, style, theme, layout, drag, delete, paste, replace-all, generalization, outerFrame, associativeLine, undo of ordinary ops.

Over-threshold import: `IMPORT_TOO_LARGE` (fail-fast, quarantine). Do not hang the room. Large-XMind performance is P1, not a Freeze breaker.

---

## ACL model

Roles: `owner` > `editor` > `viewer` (`bin/roomAcl.js`).

| Role | view | edit | ACL manage |
|---|---|---|---|
| Viewer | yes | no | no |
| Editor | yes | yes | no |
| Owner | yes | yes | yes |

Write as viewer → `FORBIDDEN` (terminal). Last owner cannot be removed/downgraded (`LAST_OWNER`).

---

## Outbox / ACK / Gap / terminal quarantine

- Outbox is sequential; one sending head; drain skips quarantined/failed ops that do **not** create UIDs later ops depend on.
- Drain dependency is **create-only** (`node.insert` / `create` / `paste` created UIDs). Failed `node.move` / `update` must not block unrelated ops on overlapping UIDs.
- ACK timeout / gap / stale base / version ahead: retryable; rebase `sendBaseRevision` to room revision; keep original base for diagnostics.
- Gap: fetch `opsAfter`; large jump may resnapshot (`AUTHORITATIVE_SNAPSHOT_RECOVERY` only).
- Terminal quarantine (no infinite replay): `FORBIDDEN`, `INVALID_CLIENT_ID`, `UID_REUSED` / `UID_EXISTS`, `CYCLE_REJECTED`, `IMPORT_TOO_LARGE`, `IMPORT_APPLY_FAILED`, `SOP_CONFIRM_REQUIRED`, `UNSUPPORTED_OPERATION`, `BAD_OP_ID`, `INVALID_PAYLOAD`, `ROOT_DELETE`, `map.replace` failures, non-cloneable outbox payload.
- SOP confirm: only SOP **root identity** (rename/delete/move SOP root, or `map.replace` that removes SOP root). Ordinary edits under SOP do not require `confirm_sop_change`.
- `clientId`: per-tab `sessionStorage`; heartbeat `mind-map-collab-v2-live:{clientId}`; claim same-user orphan outbox when heartbeat stale.

---

## Special Object invariants

| Object | Persistence |
|---|---|
| Generalization | Fields on **owner** `room_nodes.data`; virtual node UID never a `room_nodes.uid` |
| OuterFrame | Owner `data.outerFrame`; helpers not rows |
| AssociativeLine | Owner line fields; renderer placeholders not rows |
| Paste clones | `OriginalUIDSet ∩ PasteUIDSet = ∅`; no shared mutable refs (image / style / tag / note / hyperlink / mapRef / generalization) |

Business endpoints always use **business UID**.

---

## Current P1 Backlog

Non-blocking. Do not reopen V2 core for these.

- Docker / collab process restart recovery: covered by automatic tests (`test:collab:restart` / integration); **human QA deferred**
- Large XMind import performance (fail-fast already required)
- Generalization extreme Drag slot UX
- Renderer / AssociativeLine / Image small delay or brief flicker
- Long Offline-first editing: **not a product requirement**; outbox/ACK/gap/SOP quarantine are automatic-test only

Also parked: multi-select style flicker, Attachment/AI/flow-expand thinner automation, export uses hydrated runtime tree (not a raw SQL dump).

---

## What may break Freeze

Only a **true P0** may change Collaboration V2 core after this checkpoint:

- Data loss
- UID collision / cross-node data
- F5 restores a stale tree
- A/B final divergence
- PG vs UI final divergence
- Undo/Redo destroys the tree
- Privilege escalation
- Ordinary ops triggering `map.replace`
- Room permanently unopenable
- Terminal outbox infinite replay
- Special objects written as ordinary `room_nodes` rows
- Changes that would corrupt the tree model needed by later History / File System

Not Freeze-breakers: P1 UX, performance of huge XMind, Offline-first, V1/Yjs cleanup, History/folders/favorites/recycle/team space.

Do **not** delete V1 or Yjs as part of Freeze follow-up.
