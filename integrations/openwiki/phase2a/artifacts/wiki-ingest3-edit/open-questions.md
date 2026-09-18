---
type: Index
title: Open Questions
description: Open questions about this Phase 2A wiki and its core memory model.
tags: [open-questions, phase2a]
generated: { by: "openwiki/0.5.2", at: "2026-09-18T04:09:50.207Z" }
---

# Open Questions

## Active

### phase2a-scope: Which non-test rooms should this wiki cover?
- Owner: unknown
- Seen: 2026-09-18
- Evidence: [quickstart.md](quickstart.md), onboarding wiki goal
- Notes: The current scope is intentionally limited to `ow-p2a-room-a` and `ow-p2a-room-b`.
  It is unclear whether a later phase should promote real Mind Map rooms.

### room-a-edit-parity: Is room A's `P2A_EDIT_MARKER_room-a-refresh-test` a published Canonical edit?
- Owner: unknown
- Seen: 2026-09-18
- Evidence: [sources/canonical.md](sources/canonical.md#unpublished-edit-in-room-a), [rooms/ow-p2a-room-a.md](rooms/ow-p2a-room-a.md)
- Notes: The marker is visible in `/knowledge/ow-p2a-room-a/branches/hiring-sop.md` but
  `manifest.json` still describes the pre-edit 118-byte document with the old `fileHash` and
  `version` 1. It is undetermined whether the compiler re-publishes (bumping `version`/`fileHash`)
  or the direct file edit is out-of-band and must be reverted.

## Answered

## Stale
