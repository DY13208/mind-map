# History API (C1 backend, C3 UI later)

Base: collab HTTP (same host as `/api/files`). ACL via existing room membership.

All historical GET responses include `viewingHistory: true` and `readOnly: true`. They must not be used as LIVE edit sessions.

List/detail **never** return the full tree.

---

## List versions

`GET /api/files/:roomKey/versions`  
Aliases: `/api/maps/:roomKey/versions`, `/api/rooms/:roomKey/versions`

Query: `limit`, `cursor`, `type`, `createdBy`, `from`, `to`

```json
{
  "ok": true,
  "viewingHistory": true,
  "earliestAvailableRevision": 654,
  "currentRevision": 654,
  "completeFromRevision": 654,
  "historyStartRevision": 654,
  "versions": [
    {
      "versionId": "uuid",
      "revision": 600,
      "checkpointRevision": 400,
      "name": "上线前",
      "type": "MANUAL",
      "createdBy": "user-id",
      "createdAt": "2026-09-04T00:00:00.000Z",
      "description": "",
      "source": "manual",
      "readOnly": true
    }
  ],
  "nextCursor": null
}
```

ACL: view.

---

## Create version

`POST /api/files/:roomKey/versions`

```json
{ "name": "2026 Q4 SOP", "description": "上线前", "revision": 1000 }
```

`revision` optional (default current). Type default `MANUAL`.

ACL: edit (Owner / Editor). Viewer 403.

---

## Version detail

`GET /api/files/:roomKey/versions/:versionId`

Metadata only (no tree).

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
  "summary": {
    "inserted": 4,
    "updated": 12,
    "deleted": 2,
    "moved": 1,
    "restored": 0,
    "metadataChanged": true,
    "replaced": false
  }
}
```

Summary is computed from the **operation range**, not a 20k tree diff.

ACL: view. Must not mutate `room_nodes`.

---

## Restore

`POST /api/files/:roomKey/versions/:versionId/restore`

```json
{
  "expectedCurrentRevision": 1000,
  "name": "optional restore label"
}
```

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

ACL: **Owner only** (`manage`). Editor/Viewer 403.

`expectedCurrentRevision` should be the client’s live revision. Mismatch → `RESTORE_CONFLICT` (409).

Clients apply existing `map.replaced` + `VERSION_RESTORE` allowlist (`applyAuthoritativeTreeReplace`). Pending local ops are quarantined as `STALE_AFTER_VERSION_RESTORE`.

---

## Hide version (not delete history)

`POST /api/files/:roomKey/versions/:versionId/hide`

Marks the version hidden. Does **not** delete `room_operations`.

ACL: Owner.

---

## Errors

| Code | HTTP |
|---|---|
| `FORBIDDEN` | 403 |
| `VERSION_NOT_FOUND` | 404 |
| `RESTORE_CONFLICT` / `VERSION_CONFLICT` | 409 |
| `CHECKPOINT_CORRUPTED` | 409 |
| `HISTORY_REVISION_UNAVAILABLE` | 409 |
| `INVALID_HISTORY_TREE` | 400 |
