# History schema upgrade

History V2 is schema version **2** (`history_schema_state.schema_version`). Startup (`initSchema` → `initHistorySchema`) and the standalone migrator both apply it.

## Backup

```bash
pg_dump -Fc -d "$DATABASE_URL" -f mind_map_history_pre_v2.dump
```

Keep the dump until list/preview/restore have been checked on a real room.

## Apply

Restart the collab server, or:

```bash
node simple-mind-map/bin/migrateHistory.js
```

The migrator is idempotent:

1. If `room_versions` is missing or not the UUID model (no `id uuid`, has `version_no`, missing `checkpoint_revision`), it is renamed to `room_versions_legacy` (or `room_versions_legacy_<ts>` if that name exists).
2. New tables are created; compatible tables only `ALTER` missing columns (`revision` becomes nullable).
3. Legacy `room_versions_*` rows and V1 `room_snapshots` become `LEGACY` versions with stable UUIDs (`uuid v5`-style from `source + room_key + old_pk`). Old `version_no` is **not** written to `revision`.
4. Authors / theme missing → `availability: partial`. Empty tree → `unreadable` (cannot restore).
5. `rooms.restore_epoch_revision` is added.

If `history_schema_state` does not match version 2, history writes fail with `HISTORY_SCHEMA_INCOMPATIBLE` until migrate succeeds.

## Rollback

1. Stop collab writes (stop `collabServer`).
2. Restore the dump:

```bash
pg_restore -d "$DATABASE_URL" --clean --if-exists mind_map_history_pre_v2.dump
```

3. Do **not** drop `room_versions_legacy`. History rows are not deleted as a cleanup policy.

## Verify

- Repeat migrate; legacy map counts and checksums stay stable (including 4 pre-existing snapshots).
- New room lists an 初始版本; import creates `IMPORT`; idle 2 min / 15 min cap creates `AUTO`.
- Restore from files and editor; a second client reloads via `map.replaced`; offline ops with older `baseRevision` stay quarantined.
