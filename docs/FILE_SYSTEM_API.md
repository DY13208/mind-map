# File System API (C1 backend)

Canonical resource is **`rooms`**. UI may say 文件 / 脑图 / Room. There is no second tree owner (`files`, `mind_maps`, `documents`).

`API_CANONICAL_PATH`: `/api/files`  
Compat aliases: `/api/maps`, `/api/rooms` (same service).  
Folders: `/api/folders` only.

Tree loading for the editor stays the existing Collaboration V2 / `GET /api/files/:roomKey` hydrate path. File System APIs never return `room_nodes`.

Favorites / Recent / Trash / Team Space are **not** implemented. C3 keeps mocks for those.

---

## Auth / ACL

Reuses `room_members` only (`owner` / `editor` / `viewer`). No `file_permissions`.

| Action | Viewer | Editor | Owner |
|---|---|---|---|
| List / open metadata / open editor | yes | yes | yes |
| Create room | — (authenticated) | — | yes (creator becomes owner) |
| Rename room | no | yes | yes |
| Move room | no | yes | yes |
| Delete room (existing tombstone API) | no | no | yes |
| Create / rename / delete **own** folder | yes* | yes* | yes* |

\* Folder ACL is **not** inherited. Folders are organization containers. `created_by` can rename/delete. Moving a room into a folder does **not** change `room_members`.

A shared room is visible if the user is a member even when they cannot see the owner's folder as a personal directory. Folder membership is **not** required to `view` a room.

Legacy rooms with **zero** members remain `legacyOpen` (same as today).

---

## Room DTO

```json
{
  "roomKey": "room-abc",
  "title": "销售流程",
  "folderId": null,
  "owner": { "userId": "u1", "name": "u1" },
  "role": "owner",
  "createdAt": "2026-09-04T00:00:00.000Z",
  "updatedAt": "2026-09-04T00:00:00.000Z",
  "contentUpdatedAt": "2026-09-04T00:00:00.000Z",
  "resourceUpdatedAt": "2026-09-04T00:00:00.000Z",
  "revision": 0,
  "canView": true,
  "canEdit": true,
  "canManage": true
}
```

`updatedAt` for list cards = **content** time (`content_updated_at`, fallback `rooms.updated_at`).  
Rename / move bump `rooms.updated_at` only (resource metadata), not `content_updated_at`.  
Collab operation commit updates both in the **same** `UPDATE rooms` as `version` (no extra round trip). Presence / heartbeat do not.

Never returned: `nodes`, operations, checkpoint trees, full `rooms.metadata`.

---

## List rooms

`GET /api/files`

Query: `folderId` (`root` or omit for all accessible), `q` / `search` (title `ILIKE` only — not node text), `sort`=`updatedAt`|`createdAt`|`title`, `order`=`asc`|`desc`, `limit`, `offset`, `cursor`.

Default `sort=updatedAt` `order=desc`. Recent/`lastOpenedAt` is **not** this phase.

```json
{
  "ok": true,
  "list": [],
  "total": 0,
  "limit": 20,
  "offset": 0,
  "nextCursor": null
}
```

---

## Create room

`POST /api/files`

```json
{ "title": "销售流程", "folderId": null }
```

Atomic: `rooms` + root `room_nodes` + owner `room_members` + default `rooms.metadata` `{ "theme": "classic", "layout": "mindMap" }` + `version=0`. Then one `ROOM_INITIAL` history baseline (idempotent).

`roomKey` is generated (`room-` + id) and **never** changes on rename/move.

---

## Room metadata (not tree)

`GET /api/files/:roomKey/info`  
or `GET /api/files/:roomKey?view=file`

Editor tree: existing `GET /api/files/:roomKey` (and collab hydrate). Do not add a second tree API.

---

## Rename

`PATCH /api/files/:roomKey`

```json
{ "title": "2026销售流程" }
```

Title only. No `roomKey` change, no `map.replace`, no `room_nodes` write, no `room_operations`.

If body still contains collab fields (`tree`, `nodes`, `type: "map.update"`, `clientId`), the legacy `map.update` operation path is used.

ACL: **edit** (Owner / Editor). Viewer → `403 FORBIDDEN`.

---

## Move

`POST /api/files/:roomKey/move`

```json
{ "folderId": "uuid-or-null-or-root" }
```

Sets `rooms.folder_id` only. Does not copy the room, change `roomKey` / `version` / `room_nodes`, or append operations.

---

## Folders

First version: **root folders only** (`parent_id` must be null). Virtual root = `folder_id IS NULL`. Duplicate names in root → `FOLDER_NAME_CONFLICT` (case-insensitive).

`GET /api/folders` — `id, name, parentId, createdAt, updatedAt, roomCount` (count in the same query, no N+1).

`POST /api/folders` `{ "name": "Q4" }`

`PATCH /api/folders/:id` `{ "name": "Q4 SOP" }`

`DELETE /api/folders/:id` — if any rooms remain: `409 FOLDER_NOT_EMPTY`. No `ON DELETE CASCADE` of rooms. No folder nesting move.

---

## Errors

| Code | HTTP |
|---|---|
| `unauthorized` | 401 |
| `FORBIDDEN` | 403 |
| `ROOM_NOT_FOUND` / `FOLDER_NOT_FOUND` | 404 |
| `INVALID_FOLDER_NAME` | 400 |
| `INVALID_MOVE` | 400 |
| `INVALID_ROOM_KEY` | 400 |
| `ROOM_ALREADY_EXISTS` / `ROOM_DELETED` | 409 |
| `FOLDER_NAME_CONFLICT` | 409 |
| `FOLDER_NOT_EMPTY` | 409 |

---

## C3 contract

`roomService` / `folderService` HTTP mapping:

| UI | Method |
|---|---|
| list files | `GET /api/files` |
| create file | `POST /api/files` |
| file card / detail | `GET /api/files/:roomKey/info` |
| open editor | existing roomKey hydrate (not this DTO) |
| rename file | `PATCH /api/files/:roomKey` `{ title }` |
| move file | `POST /api/files/:roomKey/move` |
| list folders | `GET /api/folders` |
| create folder | `POST /api/folders` |
| rename folder | `PATCH /api/folders/:id` |
| delete folder | `DELETE /api/folders/:id` |

Swap mock → HTTP without changing page structure. Do not call File System for History UI, Favorites, Recycle, or Team Space yet.

---

## History boundary

Rename / move / folder CRUD do **not** create History versions or collab ops. History tracks mind-map content + `rooms.metadata` (theme/layout), not file organization.
