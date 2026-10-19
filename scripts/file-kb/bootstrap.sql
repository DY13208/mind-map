-- File KB admin bootstrap. Run ONCE as the PostgreSQL admin (e.g. postgres) against the
-- mind-map database, BEFORE starting the kb profile:
--
--   docker compose exec -T postgres psql -U postgres -d mind_map -v ON_ERROR_STOP=1 \
--     -v kb_password="<value of KB_PGPASSWORD in .env>" -f - < scripts/file-kb/bootstrap.sql
--
-- Idempotent. Creates role kb_app + schema kb only. It does not modify any existing
-- table, row, index or extension. Auth tables are created by the app (simple-mind-map/bin/auth.js
-- initAuth), so the app must have started at least once before this runs.

\if :{?kb_password}
\else
  \echo 'ERROR: pass -v kb_password=...'
  \quit 3
\endif

select format('create role kb_app login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit 20 password %L', :'kb_password')
  where not exists (select 1 from pg_roles where rolname = 'kb_app') \gexec
select format('alter role kb_app with login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit 20 password %L', :'kb_password') \gexec

alter role kb_app set statement_timeout = '15s';
alter role kb_app set idle_in_transaction_session_timeout = '30s';
alter role kb_app set search_path = kb;

-- Database: connect only (no CREATE / TEMP on the database).
select format('revoke all on database %I from kb_app', current_database()) \gexec
select format('grant connect on database %I to kb_app', current_database()) \gexec

-- Own schema.
create schema if not exists kb authorization kb_app;
revoke all on schema kb from public;

-- public schema: nothing except name lookup for the two auth tables below.
revoke all on schema public from kb_app;
grant usage on schema public to kb_app;
-- (PostgreSQL 15+/16 already removed CREATE on public from PUBLIC; we do not touch PUBLIC defaults.)

-- Read-only, column-level access to the app's session/user tables (see docs/file-kb/auth.md).
-- Only the columns needed to validate a session; no avatar/mobile/departments, no last_seen_at writes.
revoke all on table public.auth_sessions from kb_app;
revoke all on table public.wecom_users from kb_app;
grant select (token_hash, user_id, expires_at, absolute_expires_at) on table public.auth_sessions to kb_app;
grant select (user_id, corp_id, name) on table public.wecom_users to kb_app;

-- Optional (phase 5, trigram search). Needs superuser; uncomment when needed:
-- create extension if not exists pg_trgm;

-- Rollback (admin, destructive, only KB data):
--   drop schema kb cascade; revoke all on all tables in schema public from kb_app;
--   revoke usage on schema public from kb_app; drop role kb_app;
