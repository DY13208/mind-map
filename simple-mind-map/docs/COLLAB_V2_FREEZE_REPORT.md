# Collaboration V2 Freeze Report

Updated: 2026-09-04 during C4 selective integration onto current main.

**Freeze authority is `docs/COLLAB_V2_FROZEN.md`, not this file.**

| Field | Current main |
| --- | --- |
| `COLLABORATION_V2_CORE_FROZEN` | **YES** |
| `COLLAB_V2_TEST_FREEZE_READY` | **YES** |
| `COLLAB_V2_FREEZE_P0` | **0** |
| History backend | Ready + bootstrap safe |
| File System backend | Ready |
| C4 `codex/hx-dev` `b15aa2f3` | Tests/docs/runner merged; drain P0s fixed on current adapter (created-UID deps, no C4 target-uid) |

## Historical C4 P0 (closed, do not re-open)

C4 reproduced:

1. `CYCLE_REJECTED` on a cycle `node.move`
2. Later legal `node.delete` never drained
3. Outbox pending never returned to zero

Current adapter classifies `CYCLE_REJECTED` as terminal and uses **created-UID** `dependsOnBlockedOp` (a rejected move creates nothing, so later delete of the same uid is not blocked).

C4 drain follow-ups (also closed, freeze green):

- blocked pending no longer busy-loops (`DRAIN_BLOCKED_NO_BUSY_LOOP`)
- terminal **create** quarantines the dependent chain (`BLOCKED_BY_TERMINAL_CREATE`)
- `FORBIDDEN` quarantines the current op; independent siblings continue
- ACK/reject settle before `refreshOutboxCounts` (`OUTBOX_COUNTER_REFRESH_FAILED` is diagnostic)

Kept: `cycleRejectionDoesNotBlockDelete`.

## Suite

```text
npm run test:collab:v2:freeze    # scripts/runCollabSuite.js freeze (union of main + C4 cases)
npm run test:collab:history
npm run test:collab:files
```

`COLLAB_V2_TEST_FREEZE_READY = YES`
