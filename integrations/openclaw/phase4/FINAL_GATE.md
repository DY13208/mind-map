# Phase 4 Final Gate Report

- Started: 2026-09-18T09:56:26.520Z
- Finished: 2026-09-18T09:56:58.801Z
- Verdict: **Phase 4 Final Gate = BLOCKED**

## Summary
```json
{
  "total": 12,
  "passed": 9,
  "failed": 3,
  "criticalFailed": 3
}
```

## Gates
- FAIL [1] ACL DB unavailable fail-closed — fetch failed (17572ms)
- FAIL [2] Single-source fault degraded (not fake empty) — Command failed: docker compose exec -T knowledge-mcp sh -lc "if [ -d /data/knowledge ]; then mv /data/knowledge /data/knowledge.__fg_bak; fi"
mv: cannot move '/data/knowledge' to '/data/knowledge.__fg_bak': Read-only file system
 (736ms)
- PASS [3] timeout / circuit / rate limits (48ms)
- FAIL [4] kill mid-refresh then reconcile — stuck running: {"jobId":"0a3e63ee-5acb-4520-839f-b31dea2d204e","roomId":"room-2yaz570x","requesterUserId":"phase3-user-a","status":"running","queuedAt":"2026-09-18T09:45:00.633Z","startedAt":"2026-09-18T09:56:44.959Z","finishedAt":null,"outputHash":null,"docmostPublishStatus":"pending","error":null,"result":null} (7366ms)
- PASS [5] retry_publish is publish-only (11ms)
- PASS [6] single-instance replicas=1 (12ms)
- PASS [7] mapping/job backup smoke (2574ms)
- PASS [8] Assistant ACL E2E API A allow / B deny (188ms)
- PASS [9] Ownership regression AI upsert keeps standard/human (3044ms)
- PASS [10] Cognee slot + plugin present (240ms)
- PASS [11] Cleanup FG probe users (482ms)
- PASS [12] Runbook coverage (2ms)

## Blockers
- [1] ACL DB unavailable fail-closed: fetch failed
- [2] Single-source fault degraded (not fake empty): Command failed: docker compose exec -T knowledge-mcp sh -lc "if [ -d /data/knowledge ]; then mv /data/knowledge /data/knowledge.__fg_bak; fi"
mv: cannot move '/data/knowledge' to '/data/knowledge.__fg_bak': Read-only file system

- [4] kill mid-refresh then reconcile: stuck running: {"jobId":"0a3e63ee-5acb-4520-839f-b31dea2d204e","roomId":"room-2yaz570x","requesterUserId":"phase3-user-a","status":"running","queuedAt":"2026-09-18T09:45:00.633Z","startedAt":"2026-09-18T09:56:44.959Z","finishedAt":null,"outputHash":null,"docmostPublishStatus":"pending","error":null,"result":null}

## UI
- Sidebar: 看板 / 脑图 / 共享; 最近访问 hidden
