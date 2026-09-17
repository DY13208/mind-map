# History API

Base: collab HTTP (same host as `/api/files`). ACL via existing room membership.

All historical GET responses include `viewingHistory: true` and `readOnly: true`. They must not be used as LIVE edit sessions.

List/detail **never** return the full tree.

---

## List versions

`GET /api/files/:roomKey/versions`  
Aliases: `/api/maps/:roomKey/versions`, `/api/rooms/:roomKey/versions`

Query: `limit` (default 20), `cursor`, `type`, `createdBy`, `from`, `to`

Pagination is `(created_at desc, id desc)`. `nextCursor` is opaque.

```json
{
  "ok": true,
  "viewingHistory": true,
  "readOnly": true,
  "earliestAvailableRevision": 654,
  "currentRevision": 654,
  "completeFromRevision": 654,
  "historyStartRevision": 654,
  "nextCursor": null,
  "versions": [
    {
      "versionId": "uuid",
      "revision": 600,
      "checkpointRevision": 400,
      "name": "上线前",
      "type": "MANUAL",
      "createdBy": "张三",
      "createdById": "user-id",
      "createdAt": "2026-09-04T00:00:00.000Z",
      "description": "",
      "source": "manual",
      "sourceKind": "manual",
      "editors": [{ "userId": "user-id", "name": "张三" }],
      "summary": { "kind": "edits", "inserted": 1, "updated": 2, "deleted": 0, "moved": 0 },
      "summaryStatus": "ready",
      "summaryText": "新增 1 · 修改 2 · 删除 0 · 移动 0",
      "availability": "readable",
      "readOnly": true,
      "capabilities": { "canRestore": true, "canCreate": true }
    }
  ]
}
```

Legacy snapshots may have `"revision": null`. ACL: view.

---

## Create version

`POST /api/files/:roomKey/versions`

```json
{ "name": "2026 Q4 SOP", "description": "上线前" }
```

Only `name` / `description` are accepted. Type is always `MANUAL` at the current live revision. `type` / `revision` in the body are ignored.

ACL: edit (Owner / Editor). Viewer 403.

---

## Version detail

`GET /api/files/:roomKey/versions/:versionId`

Metadata only (no tree). Hidden or cross-room id → 404.

ACL: view.

---

## Historical tree (preview)

`GET /api/files/:roomKey/versions/:versionId/tree`

```json
{
  "ok": true,
  "viewingHistory": true,
  "readOnly": true,
  "mutable": false,
  "revision": 600,
  "metadata": { "theme": "classic", "layout": "mindMap" },
  "tree": {},
  "checksum": "hex",
  "summary": { "kind": "edits", "inserted": 4, "updated": 12, "deleted": 2, "moved": 1 }
}
```

Summary comes from the stored version row, not a live 20k-node diff. Incomplete logs → user-facing “不完整 / 资源不可用 / 加载失败”. ACL: view. Must not mutate `room_nodes`.

---

## Restore

`POST /api/files/:roomKey/versions/:versionId/restore`

Headers: `Idempotency-Key` (also accepted as `idempotencyKey` in the body).

```json
{
  "expectedCurrentRevision": 1000,
  "name": "optional restore label"
}
```

The restore **target is only** `:versionId`. `targetRevision` / `type` in the body are ignored.

Response:

```json
{
  "ok": true,
  "fromRevision": 1000,
  "targetRevision": 600,
  "newRevision": 1001,
  "preRestoreVersionId": "uuid",
  "restoreVersionId": "uuid",
  "fullTreeReason": "VERSION_RESTORE"
}
```

ACL: **Owner only** (`manage`). Editor/Viewer 403. Folder manager cannot restore.

`expectedCurrentRevision` should be the client’s live revision. Mismatch → `RESTORE_CONFLICT` (409). Same idempotency key retries return the first result.

Clients apply existing `map.replaced` + `VERSION_RESTORE`. Pending local ops with `baseRevision < restore_epoch_revision` are rejected as `STALE_AFTER_VERSION_RESTORE` and quarantined, not auto-replayed.

---

## Hide version (not delete history)

`POST /api/files/:roomKey/versions/:versionId/hide`

ACL: manage. Subsequent get/tree/restore → 404. No hide UI in this phase.
