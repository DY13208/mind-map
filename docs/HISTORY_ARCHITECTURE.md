# History Architecture

History is a **new backend** on top of frozen Collaboration V2. It does not introduce a second tree authority.

| Concept | Store | Notes |
|---|---|---|
| Current state | `room_nodes` | Live tree |
| Map metadata | `rooms.metadata` | Theme / layout / themeConfig |
| Operation log | `room_operations` | Every collab op; no GC in this phase |
| Checkpoint | `room_checkpoints` | Recovery snapshot, not a UI version |
| User version | `room_versions` | Named pointer to a revision |
| Audit | `room_history_audit` | Who created/restored what |

Legacy: `rooms.nodes` remains mirror only. `room_snapshots` (V1 JSON) is **not** History authority. Y.Doc / V1 save history is not fused.

---

## Revision vs Checkpoint vs Version

- **Operation revision** = `rooms.version` / `serverRevision` after each committed op.
- **Checkpoint** = optional snapshot at a revision so reconstruction does not replay from zero. Created on a **count threshold** (default 200 ops), after `IMPORT` / `VERSION_RESTORE`, or `PRE_RESTORE`. Not per keystroke.
- **Version** = user-visible or auto **anchor** `{ revision, name, type }`. It does **not** copy the tree.

Types: `AUTO` | `MANUAL` | `IMPORT` (reserved) | `RESTORE`.

AUTO versions: at most one per `HISTORY_AUTO_VERSION_MIN_MS` (default 15 minutes) when a threshold checkpoint is taken.

---

## Reconstruction

`getRoomStateAtRevision(roomKey, target)`:

1. `ensureHistoryBaseline(roomKey)` (lazy; no empty-tree genesis fallback).
2. If `target < earliestAvailableRevision` → `HISTORY_REVISION_UNAVAILABLE`.
3. Latest `room_checkpoints.revision <= target` (checksum verified). There is always a checkpoint after step 1.
4. Load `room_operations` in `(checkpointRevision, target]` ordered by `version`.
5. `HistoricalOperationReplayer` on an isolated memory store (never writes `room_nodes`).
6. Return `{ tree, metadata, checksum, readOnly, viewingHistory, earliestAvailableRevision, currentRevision, completeFromRevision }`.

**Existing rooms** that predate History often have a live `room_nodes` tree whose `room_operations` do **not** start at revision 1 (import, migration, archive gaps). History must not treat “empty tree + whatever ops remain” as a reconstructable past.

`ensureHistoryBaseline` (idempotent, `rooms` row `FOR UPDATE`):

- If any checkpoint exists → return the earliest; never create a second `HISTORY_BOOTSTRAP`.
- Else snapshot the **current** authoritative `room_nodes` + `rooms.metadata` + `rooms.version` as `HISTORY_BOOTSTRAP` (or `ROOM_INITIAL` when the room is still at revision 0).
- `historyAvailableFromRevision` / `earliestAvailableRevision` = that checkpoint revision.
- Triggered on first History list/create/tree/restore, checkpoint-after-op when none exist, not by scanning every room at server start, and **not** on every `node.update` apply.

New rooms: first History touch at revision 0 writes `ROOM_INITIAL`. Import still takes an immediate `IMPORT` checkpoint. Restore refuses `targetRevision < earliestAvailableRevision`. Legacy `room_snapshots` is not History authority.

Replay types: `node.insert|update|move|reorder|delete|restore|batch`, `map.meta.update`, `map.replace`, `operation.undo|redo`.

`map.replace` (IMPORT): after success, an immediate checkpoint is taken so later reconstruction does not depend on a huge payload.

---

## Restore semantics

Restore **never decreases** `rooms.version`.

Example: current `1000`, restore revision `600` → new revision `1001` = `VERSION_RESTORE` (`map.replace` + `fullTreeReason: VERSION_RESTORE`). History still contains 600…1000 plus 1001.

Before replace: `PRE_RESTORE` checkpoint + version so the previous live state is recoverable.

Transaction: lock `rooms` (`FOR UPDATE`) → reconstruct → validate tree → pre snapshot → write `room_nodes` + metadata + revision + operation + post checkpoint. Failure rolls back.

Concurrent restore with the same `expectedCurrentRevision`: first wins, second `RESTORE_CONFLICT`.

Ordinary Ctrl+Z does **not** undo restore. Re-restore the pre-restore version.

Clients already treat `map.replaced` as authoritative reload. Adapter additionally quarantines pending outbox as `STALE_AFTER_VERSION_RESTORE` (no silent replay onto the new tree).

---

## ACL

| Action | Viewer | Editor | Owner |
|---|---|---|---|
| List / detail / tree (read-only) | yes | yes | yes |
| Create MANUAL version | no | yes | yes |
| Hide version | no | no | yes |
| Restore | no | no | yes |

---

## Retention

Keep all `room_operations`. Do not prune until a later phase guarantees covering checkpoints.

---

## Config

| Env | Default |
|---|---|
| `HISTORY_CHECKPOINT_EVERY` | 200 |
| `HISTORY_AUTO_VERSION_MIN_MS` | 900000 |
| `HISTORY_AUTO_VERSION_ON_CHECKPOINT` | true |
