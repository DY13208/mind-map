# Full Tree Mutation Audit

Ordinary Text / Style / Move / Delete / Paste / Theme / Search must not `map.replace`.

Allowlist (current main): `IMPORT`, `IMPORT_UNDO`, `VERSION_RESTORE`, `INITIAL_LEGACY_MIGRATION`, `AUTHORITATIVE_SNAPSHOT_RECOVERY`.

Guards remain in Cooperate remote apply, `Render.setData`, paste undo. C4 did not change this list. File-system rename/move must not create `map.replace` (enforced in File System backend).
