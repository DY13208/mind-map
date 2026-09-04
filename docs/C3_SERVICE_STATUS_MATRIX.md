# C3 Service Status Matrix

Mode switching lives in `web/src/services/*`. Vue pages must not branch on `if production axios else mock`.

| Domain | Status | Source |
|---|---|---|
| Room | REAL | `GET/POST/PATCH /api/files`, `POST /api/files/:roomKey/move`, `GET /api/files/:roomKey/info` |
| Folder | REAL | `GET/POST /api/folders`, `PATCH/DELETE /api/folders/:id` |
| History | REAL | `/api/files/:roomKey/versions` |
| Share | REAL | `/api/files/:roomKey/members` (`room_members`) |
| Recent | MOCK_PENDING | User × Room `lastOpenedAt` is not implemented |
| Favorites | MOCK_PENDING | `room_user_state` is not implemented |
| Trash | MOCK_PENDING | Do not call real room DELETE / tombstone |
| Team | MOCK_PENDING | No team_space schema |

`SHARE_BACKEND_PENDING = false` (member list/add/change-role/remove exist).

Stable ID: `roomKey`. UI `id` is an alias of `roomKey`.
