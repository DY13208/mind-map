-- geekcloud:read is an opt-in MCP token scope for JackYun (吉客云) read-only queries.
-- kb:read is still required by the API; folder-scoped tokens cannot carry geekcloud:read (enforced in api.js).
-- Only relaxes the scope check; no data is changed.
set local lock_timeout = '5s';
alter table kb.mcp_tokens drop constraint if exists kb_mcp_tokens_scopes_chk;
alter table kb.mcp_tokens add constraint kb_mcp_tokens_scopes_chk
  check (scopes <@ array['kb:read', 'kb:write', 'kb:admin', 'geekcloud:read']::text[] and cardinality(scopes) > 0);
