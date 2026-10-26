-- Short-lived MCP downloads inherit the lifecycle of their originating token.
alter table kb.direct_links add column source_token_hash text
  check (source_token_hash is null or source_token_hash ~ '^[a-f0-9]{64}$');
