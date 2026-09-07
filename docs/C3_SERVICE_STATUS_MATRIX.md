# C3 Service Status Matrix

Mode switching lives in `web/src/services/*`. Vue pages must not branch on `if production axios else mock`.

| Domain | Status | Source |
|---|---|---|
| Room | REAL | `GET/POST/PATCH /api/files`, `POST /api/files/:roomKey/move`, `GET /api/files/:roomKey/info` |
| Folder | REAL | `GET/POST /api/folders`, `PATCH/DELETE /api/folders/:id` |
| History | REAL | `/api/files/:roomKey/versions` |
| Share | REAL | `/api/files/:roomKey/members` (`room_members`) |
| Recent | REAL | `GET /api/files/recent`; open updates `room_user_state.last_opened_at` |
| Favorites | REAL | `GET /api/files/favorites`, `POST/DELETE /api/files/:roomKey/favorite` |
| Trash | REAL | `rooms.deleted_at` + trash/restore/permanent APIs; not `room_nodes.deleted_at` |
| Team | MOCK_PENDING | No team_space schema |

`SHARE_BACKEND_PENDING = false` (member list/add/change-role/remove exist).

Stable ID: `roomKey`. UI `id` is an alias of `roomKey`.
