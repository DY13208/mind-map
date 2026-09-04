# V2 Authority Audit

Current main freeze (`docs/COLLAB_V2_FROZEN.md`). Line numbers drift; semantics are frozen.

| Domain | Authoritative source | Result |
| --- | --- | --- |
| Tree | `room_nodes` | Unique once V2 table initialized |
| Metadata | `rooms.metadata` | Separate from tree |
| Operations | `room_operations` | Op log |
| History | `room_checkpoints` / `room_versions` | Not a second live tree |
| File organization | `rooms.folder_id` / `folders` | Not tree authority |
| `rooms.nodes` | Legacy mirror | Not V2 live authority |

Full-tree `map.replace` remain allowlisted: IMPORT, IMPORT_UNDO, VERSION_RESTORE, INITIAL_LEGACY_MIGRATION, AUTHORITATIVE_SNAPSHOT_RECOVERY.
