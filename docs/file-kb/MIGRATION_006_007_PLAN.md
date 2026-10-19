# 006 / 007 migration impact and rollback plan

Status: implemented and tested on isolated PostgreSQL. Local `mind_map` then
received both migrations without a separate approval prompt: at 2026-10-19
10:09 (UTC+8) the recreated `mind-map-file-kb-1` container ran migrate-on-start.
`kb.schema_migrations` records `006_structure_correctness` at 02:09:33Z and
`007_batches_metrics` at 02:09:34Z. `kb.batches`, `kb.batch_items` and
`kb.job_attempts` are empty. `一张表.xlsx` remains parse version 3, 61 fields,
1409 records, sha256 `267cfaea6d88f989669f82de420afd3314ddd32dfa522e8882dafd44daf57530`.
At 10:29 (UTC+8) API and Worker were recreated together on image
`sha256:aa1e88b63e27072c946bdf196ef579c2d5eaac4f0b07e4615529d096268ea6ae`.
migrate-on-start did not apply 006/007 again; `applied_at` is unchanged.
`kb.batches` is still empty. No KB file was reparsed. Batches may be created
against this build. `FILE_KB_MIGRATE_ON_START` stays at its default (on); applied
versions are skipped.

## Impact

006 examines the columns of unique constraints on kb.fields and removes only the
legacy `(run_id,sheet,col_index)` uniqueness, retaining 005's table-aware unique
constraint. Adds metadata-only defaulted records.table_index and nullable cell_range,
plus safe numeric/date conversion functions. Does not delete/rewrite file contents,
parse runs, fields or records, and does not automatically republish a run.

007 adds kb.batches, kb.batch_items and kb.job_attempts, plus batch/class/metrics/
first_started_at columns on kb.jobs. It backfills resource_class on existing KB jobs
from kind and extension. This is the only existing-row update in 007. It does not
cancel, restart, enqueue, retry or delete existing jobs. No public schema table,
role grant, Mind Map/collaboration/MinerU/Cognee/Wiki/old MCP object is changed.

Both migrations run in the existing migrator's separate transactions, with 5s lock
timeout and 30s statement timeout. Failure rolls back that migration. Their names
are appended to kb.schema_migrations. Migration 005 is not edited/re-executed.

## Before approved deployment

1. Capture current one-sheet file id/current_run_id/version/sha256, effective field
   and record counts, and row-data digests. Record kb.jobs states and schema versions.
2. Take an operator-approved backup of kb schema/data and KB original/raw file volume;
   keep the matching service/MCP image identifiers and configuration. Do not export
   credentials into logs. The current one-sheet expectation is 61 fields/1409 rows.
3. Stop admitting KB uploads and let current KB transactions drain; coordinate API,
   Worker and file-kb-mcp rollout together. Original Mind Map services stay running.
4. Apply migrations once using the KB owner/migration role. Validate constraints and
   original data before enabling new service code. No blanket parse/restructure job.
5. Update frontend source/mapping conventions before exposing MCP debugger v2 to users:
   the old debugger adds/subtracts 1 under the old MCP row convention.

## Rollback

- If DDL fails: the migrator rolls back the current transaction; keep old binaries,
  inspect the recorded versions, and resolve the lock/DDL error. Do not run DROP SCHEMA.
- Preferred application rollback: disable the new KB entry points and keep the new
  additive schema, batches and attempt history intact while rolling the service code
  forward to a fixed image. Do not delete batches, metrics, historical runs or records.
- Old Worker code ignores paused/cancelled batch controls. Therefore **never launch
  the old Worker on outstanding new batches**. Drain with the new Worker or keep KB
  workers stopped until a compatible build is ready. No changes to original app queue.
- Reinstating legacy uniqueness is possible only before any distinct table_index has
  duplicated a `(run_id,sheet,col_index)` combination. Preflight with GROUP BY/HAVING;
  if any exist, do not discard fields to force rollback. Keep the forward schema.
- Do not drop new columns/tables/functions during routine rollback. Physical schema
  restoration from backup is a separate destructive recovery operation requiring
  a new explicit decision and precise recovery-point verification.

## Approval scope to request after review

Apply **only** 006_structure_correctness and 007_batches_metrics to current mind_map;
retain every KB object and file; coordinate only File KB API/Worker/new MCP rollout.
No permission is implied to reparse user documents, rebuild the frontend, modify
legacy services, delete test/business data, or change global production concurrency.
