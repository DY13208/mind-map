# Liangce Knowledge System V1 — Operations Runbook

## Scope
Production ops for Knowledge MCP + OpenClaw + Docmost/OpenWiki + Cognee on a **single replica** of `knowledge-mcp`.

## replicas policy (hard limit)
- `KNOWLEDGE_MCP_REPLICAS_POLICY=single`
- `docker-compose.yml` → `knowledge-mcp.deploy.replicas: 1`
- OpenWiki refresh locks are **in-process** (not cross-host). Do **not** scale `knowledge-mcp` above 1.

## start/stop
```bash
# recommended
./Start-Docker.bat
# or
node scripts/docker-up.js

docker compose stop knowledge-mcp openclaw-gateway
docker compose up -d knowledge-mcp openclaw-gateway
```

## health/ready
```bash
curl -s http://127.0.0.1:18792/health
curl -s http://127.0.0.1:18792/ready   # includes aclDb, jobStore, circuits, replicasPolicy
```

## Docmost sync
- Canonical→Docmost standard sync remains Phase-1 pipeline (app/compiler).
- AI slot writes only via Knowledge MCP `docmost_ai_upsert`.
- On publish failure after OpenWiki generation: call `openwiki_retry_publish` (publish only, no regenerate).

## Knowledge MCP
- Image: `mind-map-knowledge-mcp:0.4.0` (non-root uid 1000, cap_drop ALL + minimal caps, read_only).
- JWT: `KNOWLEDGE_MCP_JWT_SECRET`, iss=`openclaw-liangce`, aud=`knowledge-mcp`.
- ACL fail-closed: if Mind Map ACL DB is unreachable → tools error `acl_unavailable` (never default-allow).

## OpenWiki jobs/retry
```bash
# status
# tools: openwiki_refresh / openwiki_refresh_status / openwiki_retry_publish
docker compose logs -f knowledge-mcp | findstr /i openwiki
# stale running reclaim on boot / refresh entry
```
If process killed mid-refresh: restart `knowledge-mcp`; stale `running` jobs are reclaimed (`reclaimed_stale_running`) and can be retried. Must not remain `running` forever.

## Cognee
- `plugins.slots.memory` must stay `cognee-openclaw`.
- Knowledge MCP and Cognee are separate chains; do not route Knowledge ACL through Cognee.

## ACL fault
1. Confirm `/ready` → `checks.aclDb.ok=false` or tool errors `acl_unavailable`.
2. Restore Postgres network/credentials.
3. Re-check `/ready` and a `canonical_list` call.

## secret rotation
1. Generate new `KNOWLEDGE_MCP_JWT_SECRET` (and handoff secret if used).
2. Update `.env` on the host.
3. `docker compose up -d knowledge-mcp openclaw-gateway` (inject config via Start-Docker).
4. Old tokens fail closed after TTL (~180s).

## backup/restore
```bash
docker compose exec -T postgres pg_dump -U postgres -d mind_map \
  -t knowledge_docmost_mappings -t knowledge_openwiki_jobs > backup_knowledge.sql

# restore (maintenance window)
docker compose exec -T postgres psql -U postgres -d mind_map < backup_knowledge.sql
```
Also backup OpenWiki room files under `data/openwiki/rooms` and audit logs volume.

## OpenClaw upgrade
1. Pin image: `OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.9.3` (do not float `latest` in prod).
2. `docker compose pull openclaw-gateway` (specific tag) && recreate.
3. Start-Docker syncs `liangce-ingress` into the named volume automatically.
4. Verify `plugins.slots.memory=cognee-openclaw` and `/ready` on Knowledge MCP.

## Sidebar chrome
Product shell labels: 看板 / 脑图 / 共享 (最近访问 hidden).