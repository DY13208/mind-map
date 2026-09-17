# History Architecture

History is a **new backend** on top of frozen Collaboration V2. It does not introduce a second tree authority. Users pick a time and restore; they never see revision / checkpoint jargon.

| Concept | Store | Notes |
|---|---|---|
| Current state | `room_nodes` | Live tree |
| Map metadata | `rooms.metadata` | Theme / layout / themeConfig |
| Operation log | `room_operations` (+ archive) | Every collab op; no GC in this phase |
| Checkpoint | `room_checkpoints` | Recovery snapshot, not a UI version |
| User version | `room_versions` | Named pointer to a revision (or a legacy snapshot) |
| Auto job | `room_history_auto_jobs` | Idle 2 min / max 15 min retain |
| Restore idempotency | `room_restore_idempotency` | Same key returns the same restore |
| Legacy map | `room_version_legacy_map` | Old `room_snapshots` / incompatible `room_versions` |
| Audit | `room_history_audit` | Who created/restored/hid what |

Legacy: `rooms.nodes` remains mirror only. `room_snapshots` (V1 JSON) is **not** live History authority after migration; rows are copied into `LEGACY` versions with `revision: null`. Y.Doc / V1 save history is not fused.

Schema version is stored in `history_schema_state`. Mismatch rejects history writes (`HISTORY_SCHEMA_INCOMPATIBLE`). See [HISTORY_UPGRADE.md](./HISTORY_UPGRADE.md).

---

## Revision vs Checkpoint vs Version

- **Operation revision** = `rooms.version` / `serverRevision` after each committed op.
- **Checkpoint** = optional snapshot at a revision so reconstruction does not replay from zero. Created on a **count threshold** (default 200 ops), after `IMPORT` / `VERSION_RESTORE`, or `PRE_RESTORE`. Not per keystroke. Checkpoints read `rooms.version`, `rooms.metadata`, and `room_nodes` in the same transaction snapshot; if revision moved, the write is retried or abandoned.
- **Version** = user-visible **anchor** `{ id, revision?, name, type, editors, summary }`. It does **not** copy the live tree except for `LEGACY` snapshots.

Types: `AUTO` | `MANUAL` | `IMPORT` | `PRE_RESTORE` | `RESTORE` | `LEGACY`.

AUTO versions are **not** tied to the 200-op checkpoint. After each committed op (except `VERSION_RESTORE`), the server upserts `room_history_auto_jobs`:

`due_at = min(last_activity + 2min, last_auto_at + 15min)`  
(first AUTO after a room is created uses only the 2 minute idle).

A process worker claims due jobs with `FOR UPDATE SKIP LOCKED`. Closing the browser does not cancel them. Same `room_key + revision` AUTO is idempotent.

---

## Reconstruction

`getRoomStateAtRevision(roomKey, target)`:

1. `ensureHistoryBaseline(roomKey)` (lazy; no empty-tree genesis fallback unless ops are complete from revision 1).
2. If `target < earliestAvailableRevision` → `HISTORY_REVISION_UNAVAILABLE`.
3. Latest `room_checkpoints.revision <= target` (checksum verified).
4. Load `room_operations` ∪ archive in `(checkpointRevision, target]` ordered by `version`.
5. Require continuous versions; unsupported `operation_type` fails; undo/redo lookup may fetch the target op from **before** the checkpoint (including archive).
6. `HistoricalOperationReplayer` on an isolated memory store (never writes `room_nodes`).
7. Return `{ tree, metadata, checksum, readOnly, viewingHistory, … }`.

Tree GET is cached in-process (LRU, key `versionId + checksum`) after the first successful rebuild.

`ensureHistoryBaseline` (idempotent, `rooms` row `FOR UPDATE`):

- If any checkpoint exists → return the earliest; never create a second `HISTORY_BOOTSTRAP`.
- Else snapshot the **current** authoritative tree as `HISTORY_BOOTSTRAP` (or `ROOM_INITIAL` at revision 0). `ROOM_INITIAL` also writes a visible **初始版本**.
- Existing rooms only reconstruct from that bootstrap forward.

Import success writes an immediate `IMPORT` checkpoint **and** an `IMPORT` version.

---

## Restore semantics

Restore **never decreases** `rooms.version`.

1. Authorize `manage`. Hidden / cross-room id / unreadable → 404 or 409.
2. Rebuild the historical tree **outside** the room lock.
3. Short transaction: `FOR UPDATE` room → OCC `expectedCurrentRevision` → `PRE_RESTORE` checkpoint+version → live tree/metadata/revision/`restore_epoch_revision` → `map.replace` op + `room_outbox` + `pg_notify` → `VERSION_RESTORE` checkpoint + `RESTORE` version → audit + idempotency row.
4. After commit: `invalidateRoomCache` and knowledge `recordLegacySave`.

Request body **cannot** choose the target; only URL `versionId`. Create version only accepts `name` / `description` (type is always `MANUAL`).

Same `Idempotency-Key` retries return the first result. A different key after the live revision moved → `RESTORE_CONFLICT`.

`rooms.restore_epoch_revision` rejects later collab ops whose `baseRevision` is below the epoch (`STALE_AFTER_VERSION_RESTORE`). Local outbox is quarantined, not auto-replayed. Peers reload via `map.replaced`.

---

## ACL

| Action | Viewer | Editor | Owner |
|---|---|---|---|
| List / detail / tree (read-only) | yes | yes | yes |
| Create manual version | no | yes | yes |
| Restore / hide | no | no | yes |

Folder `manager` still maps to editor and **cannot restore**. Sharing, team, and folder inheritance are unchanged. Restore does not change filename, owner, members, team, or folder. Attachments keep historical references only.

Hidden versions 404 on get/tree/restore and write `VERSION_HIDE` audit. There is no hide UI in this phase.

---

## Summaries and editors

Background stats from the previous visible version to this one (`insert/update/delete/move`) are stored on `summary`. List does not load trees or scan from revision 0. Missing summaries show 「整理中」. Import / restore / legacy / initial use fixed copy, not op counts. Editor names join `wecom_users`.

---

## Frontend

One `HistoryPanel` is used from the file list and the editor toolbar (next to Share). Desktop: readonly mind-map preview + date-grouped timeline. Preview uses an isolated `MindMap` (`readonly`); close calls `destroy()`. Restore confirms time, automatic backup, and collaborator reload.
