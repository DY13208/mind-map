# File KB backend contracts: source v2 / mapping v2 / batches v1

2026-10-19. Backend integration contract for the frontend Agent. No UI is changed
by this delivery. Requires migrations 006 and 007; do not deploy against a schema
still at 005. The existing web CONTRACT.md describes the older MCP row convention.

## Source and filters

- HTTP `/records` and MCP `query_knowledge_records` use the same `records.js`.
- `row` / `source.row` are **original spreadsheet row numbers, starting at 1**.
  `rowIndex` is an explicitly labelled 0-based compatibility field. Responses carry
  `coordinateVersion: 2, rowBase: 1`. Remove the old debugger's unconditional +1.
- MCP `get_knowledge_source`: send `row: 3` for spreadsheet row 3. To consume an old
  index explicitly, send `rowIndex: 2` instead. Do not subtract one from `row`.
- `source.cell` is a row range (`A3:BI3`) when representing an entire record.
  Supply `field: "日常工作"` to get an exact cell and its value. A PDF block uses
  page + normalized bounding box; it is not assigned an invented spreadsheet cell.
- `bbox` is always `[x0,y0,x1,y1]`, 0..1, top-left origin. Stored `bbox.norm` wins.
- Both date aliases `recordDate` and `date` return `YYYY-MM-DD` or null.
- Record IDs remain strings (PostgreSQL bigint safety). `tableIndex` identifies a
  table on a Sheet. Record query supports `sheet`, `tableIndex`, `cursor`, page and
  pageSize/limit. Total counts all matching records, not just the remaining cursor.
- Filters: `{field, op:'eq'|'contains'|'range', value?, min?, max?, type?, column?}`.
  Arbitrary printable JSON field names up to 200 characters are parameter-bound,
  including `耗时(h)`. No dynamic SQL identifiers are built from them.
- Reserved typed columns: sku, price, stock, date/record_date. `column` can select
  one explicitly while retaining a display field name. Numeric range on a custom
  field uses safe numeric conversion, not lexical order. ISO-date range infers date;
  `type:'date'|'number'|'integer'|'text'` makes intent explicit. Malformed cells are
  null for numeric/date comparisons; malformed filter values are HTTP 400.

## Manual header mapping

`GET /files/:id/layout` additionally returns `rowCount`, `columnCount`,
`mappingVersion:2`, `columnsAreSnapshot:true` for each sheet. `columns` is a preview
snapshot, **not** an instruction to rename every column.

Preferred request to `POST /files/:id/structure`:

```json
{"sheets":[{"sheet":"Inventory","headerRows":[2],"dataStartRow":3,
 "columnOverrides":[{"index":2,"name":"Daily work"}]}]}
```

`columnOverrides` contains only deliberate user renames, with zero-based indices.
Omit it or send `[]` to derive names from selected source header rows. The backend
normalizes this to the existing pipeline's internal `columns` map.

Compatibility for old clients: if only `columns` is supplied and headerRows changed
relative to the applied/detected layout, discard the snapshot and derive new names.
If the selection is unchanged, only names differing from the baseline are retained
as renames. A client changing rows and renaming simultaneously must use
`columnOverrides`; the backend never guesses that a full old snapshot was intended.

Sheet names and row boundaries are validated against the original workbook. Original
bytes are never rewritten. Low confidence keeps the previous effective run. The
current manual API still accepts one region per Sheet; multiple automatic regions
are persisted with tableIndex. Separate per-region manual mapping is future work.

## Batch lifecycle

All routes are under `/api/kb`; normal login/Origin protections and token scopes
apply. The batch belongs to its creator. A folder-scoped token is rejected for
batch administration (`batch_scope_unsupported`), rather than leaking metadata
outside its folder. Use the login session or an unscoped suitably authorized token.

| Method/path | Request | Result |
|---|---|---|
| POST `/batches` | `{name?,expectedCount:100}` (1..1000) | 201 batch status with id |
| GET `/batches` | `limit<=100,cursor?` | owned batch statuses + nextCursor |
| POST `/files?batch_id=UUID&client_key=stable-item-key` | one multipart file | file response plus batchId; parsing is asynchronous |
| POST `/batches/:id/seal` | `{}` | stop accepting new client keys; received may be below expectedCount |
| GET `/batches/:id` | — | counters, progress, state |
| GET `/batches/:id/items` | `limit<=200,cursor?` | per-item state/error/upload_metrics/file_id/run_id |
| GET `/batches/:id/metrics` | — | existing jobs + immutable attempt history |
| POST `/batches/:id/pause` | `{}` | stop new files being claimed |
| POST `/batches/:id/resume` | `{}` | allow new claims again |
| POST `/batches/:id/cancel` | `{}` | cancel waiting items/jobs only; started files finish |
| POST `/batches/:id/retry` | `{}` | retry failed jobs using same job/run with new lease |

Example status:

```json
{"id":"...","state":"running","control":"running","sealed":true,
 "total":100,"received":100,"notUploaded":0,"waiting":70,"processing":2,
 "done":25,"partial":1,"failed":2,"cancelled":0,"completed":28,"progress":0.28}
```

State: accepting / running / paused / cancelling / done / partial / failed /
cancelled. The persisted control flag is running / paused / cancelled; terminal
state and counters are derived from items. `completed` includes all terminal items,
including failed/cancelled; `done` means successful files only.

Pause/cancel do not invalidate running leases or transactions. The currently claimed
phase finishes. Pause prevents the next queued phase from starting until resume.
Cancel removes queued phases, including a queued structure phase; an in-flight parse
finishes its raw output but does not enqueue structure afterwards. An already running
structure phase may finish and publish atomically. Unstarted runs/files retain
failure/detail evidence rather than deleting history. Cancelling a partial upload
retains notUploaded in the status.

Replays of the same client_key and file are idempotent. A different file under an
already successful key is 409. Content duplicates link to an existing run and do
not generate records again; they remain dependent on the original run, so pausing
the referencing batch cannot pause work owned by another batch. Failed-upload
items have no run: retry reopens upload, the client resends that same key and seals
again. Missing/cancelled/superseded jobs are not silently reconstructed.

### Frontend upload flow

1. Create batch, retain id and stable item keys; show progress immediately.
2. Send individual files with upload concurrency 2 (at most configured upload limit).
   Do not send one 100-file multipart request or wait for parsing in its response.
3. On 429, read `Retry-After` (seconds) or body `retryAfterMs`. The code says which
   limiter fired: `too_many_concurrent_uploads` (3s), `rate_limited` (remaining
   minute window, otherwise 15s), `queue_full` (20s). Other 429s use 10s.
   Do not mark the item permanently failed or busy-loop. Queue bounds remain active.
4. Seal when the client will not add new files, including after local cancels.
   received may be lower than expectedCount. notUploaded stays in the status.
   A sealed batch with any successful file and a shortfall is `partial`, not `done`.
5. Poll status every 1–3 seconds, stop on terminal state; fetch item pages as needed.
6. Retry only failed slots. For failed upload slots, resend the same client_key;
   seal stays closed and a new key is 409 `batch_closed`. For failed jobs, the
   server reuses the run and idempotent stage reset. Do not expect seal to reopen.

Limits differ: expectedCount is a manifest bound; maxFilesPerBatch is the bound on
one HTTP multipart request. The server returns quickly after staging/enqueue, not
after Docling. The browser remains responsive while capacity backpressure waits.

## Scheduling and metrics

One existing `kb.jobs` queue remains authoritative. Admission uses a transaction
advisory lock + SKIP LOCKED. Global, light/heavy, and optional per-format caps are
checked across workers in the same database. Every worker must use the same limits.
Structure work is prioritized to avoid starving completion behind 100 parse jobs.

Configuration (defaults):

```text
KB_WORKER_CONCURRENCY=2
KB_LIGHT_CONCURRENCY=2
KB_HEAVY_CONCURRENCY=1
KB_FORMAT_CONCURRENCY={}             # optional e.g. {"pdf":1,"xlsx":2}
KB_MAX_QUEUED_PER_USER=50
KB_MAX_ACTIVE_JOBS=500
KB_NATIVE_LIGHT_PARSE=false
KB_NATIVE_LIGHT_MAX_BYTES=2097152
```

Light jobs: structure + xlsx/md/csv parse. Heavy jobs: remaining parses including
PDF/images/OCR. Per-format caps apply to parse jobs, not structure. No second queue.
Native light mode, when enabled, processes small XLSX with ExcelJS and small Markdown
as preserved text, bypassing Docling. Large files fall back to Docling. Metrics
identify parser; `docling_status=native_success` explicitly avoids pretending native
output came from Docling. Native XLSX has records/notes rather than Docling table blocks.

Job/attempt metrics: first queue wait, attempt wait, parseMs/structureMs, dbMs,
dbWriteMs, totalMs, computeEstimateMs, sampled process RSS and process CPU delta,
failureReason. Per-file GET detail includes job metrics. Batch items hold upload
wall time, bytes, sampled RSS and DB timings. Job attempts retain the lease, attempt,
worker, outcome and error, including lease_expired on recovery.

RSS is process-level sampled usage, and CPU delta includes overlapping jobs; neither
is exclusive per-file attribution. DB timing is cumulative query time and can
overlap wall time. Container CPU/RSS peaks are measured by the lab harness, not
invented from these counters. True Docling compute processing_time is recorded
separately from client submit/poll wall time.

## Phase 3 additions (2026-10-19)

These are part of the same `/api/kb` surface. No Idempotency-Key was added.

### Upload limits

`GET /api/kb/health` includes `limits`:

```json
{"maxFileBytes":104857600,"maxBatchBytes":209715200,"maxFilesPerBatch":50,
 "uploadConcurrencyPerUser":4,"uploadFilesPerMinute":120,"maxQueuedPerUser":50,
 "allowedExtensions":["pdf","docx","pptx","xlsx"]}
```

Values come from the running config, not from a frontend constant. `allowedExtensions`
is the full server allow-list.

### Excel page preview

`GET /files/:id/layout?sheet=Inventory&from_row=20&limit=50`

`from_row` is the 1-based spreadsheet row (default 1). `limit` is 1..200 (default 12).
The targeted sheet's `preview` contains only that window, including blank rows inside
it. `rowCount` / `columnCount` still describe the sheet. `previewFromRow` and
`previewLimit` repeat the window. A missing sheet name is 404 `missing`. An out-of-range
query is 400 `bad_layout`. The browser does not download the workbook for this call.
Header detection still uses the top of the sheet; this route does not parse every row
into the response.

### SHA256 dedup

Uniqueness is `(coalesce(team_id,''), owner_id, sha256)` among rows with
`deleted_at is null`. It is not per folder. Uploading the same bytes into another
folder returns the existing file with `duplicate:true` and does not create a copy,
a parse run, or a job. After a soft delete, the same bytes create a new file row
and a new parse run; the stored object remains content-addressed. A lost response
followed by a retry of the same bytes is therefore safe while the file still exists.
No separate lookup or Idempotency-Key is required for that retry.

### 429

Body is `{error, code, retryAfterMs}`. Header `Retry-After` is the same wait in
whole seconds. Codes: `too_many_concurrent_uploads`, `rate_limited`, `queue_full`.

### Seal

`POST /batches/:id/seal` always closes admission. It does not require
`received == expectedCount`. Existing failed upload keys can still be replaced.
New keys after seal return 409 `batch_closed`. Cancel and job retry are unchanged.
