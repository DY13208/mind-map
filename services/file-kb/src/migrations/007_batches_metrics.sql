set local lock_timeout = '5s';
set local statement_timeout = '30s';
create table kb.batches (
  id uuid primary key default gen_random_uuid(), owner_id text not null,
  name text not null default '', expected_count integer not null check(expected_count between 1 and 1000),
  control text not null default 'running' check(control in ('running','paused','cancelled')),
  sealed_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index kb_batches_owner_idx on kb.batches(owner_id,created_at desc,id);
create table kb.batch_items (
  id uuid primary key default gen_random_uuid(), batch_id uuid not null references kb.batches(id),
  client_key text not null, file_id uuid references kb.files(id), run_id uuid references kb.parse_runs(id),
  name text not null, state text not null default 'waiting'
    check(state in ('waiting','processing','done','partial','failed','cancelled')),
  duplicate boolean not null default false, error text, upload_metrics jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(batch_id,client_key)
);
create index kb_batch_items_run_idx on kb.batch_items(run_id);
alter table kb.jobs add column batch_id uuid references kb.batches(id);
alter table kb.jobs add column resource_class text not null default 'heavy' check(resource_class in ('light','heavy'));
alter table kb.jobs add column first_started_at timestamptz;
alter table kb.jobs add column metrics jsonb not null default '{}';
update kb.jobs j set resource_class=case when j.kind='structure' or f.ext in ('xlsx','md','csv') then 'light' else 'heavy' end
  from kb.files f where f.id=j.file_id;
create table kb.job_attempts (
  id bigserial primary key, job_id bigint not null references kb.jobs(id),
  lease_token uuid not null unique, attempt integer not null, worker_id text,
  started_at timestamptz not null default now(), finished_at timestamptz,
  outcome text, error text, metrics jsonb not null default '{}'
);
create index kb_job_attempts_job_idx on kb.job_attempts(job_id,id);
