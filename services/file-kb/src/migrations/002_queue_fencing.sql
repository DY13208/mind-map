-- Phase 2: fencing token for job leases + file metadata used by the pipeline.
alter table kb.jobs add column if not exists lease_token uuid;
alter table kb.jobs add column if not exists deferred_count integer not null default 0;
alter table kb.files add column if not exists ext text not null default '';
alter table kb.parse_runs add column if not exists docling_status text;
alter table kb.parse_runs add column if not exists stats jsonb not null default '{}'::jsonb;
create index if not exists kb_jobs_file_idx on kb.jobs (file_id, created_at desc);
alter table kb.blocks add column if not exists data jsonb;
