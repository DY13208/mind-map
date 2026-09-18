---
type: Index
title: Open Questions
description: Open questions about this Phase 2A wiki and its core memory model, including the status of room A's deleted SOP branch.
tags: [open-questions, phase2a]
generated: { by: "openwiki/0.5.2", at: "2026-09-18T04:11:06.782Z" }
---

# Open Questions

## Active

### phase2a-scope: Which non-test rooms should this wiki cover?
- Owner: unknown
- Seen: 2026-09-18
- Evidence: [quickstart.md](quickstart.md), onboarding wiki goal
- Notes: The current scope is intentionally limited to `ow-p2a-room-a` and `ow-p2a-room-b`.
  It is unclear whether a later phase should promote real Mind Map rooms.

### room-a-deletion-finality: Is room A's SOP branch deletion final, or will the compiler re-publish it?
- Owner: unknown
- Seen: 2026-09-18
<!-- openwiki: broken internal link [sources/canonical.md#deletion-in-room-a-branches-hiring-sop-md] heading anchor "deletion-in-room-a-branches-hiring-sop-md" does not exist in "sources/canonical.md". Fix the href or restore the target, then delete this comment. -->
- Evidence: [sources/canonical.md](sources/canonical.md#deletion-in-room-a-branches-hiring-sop-md), [rooms/ow-p2a-room-a.md](rooms/ow-p2a-room-a.md)
- Notes: `branches/` is empty and `manifest.documents` lists only `README.md`, but `version` stayed at 1
  and `branches/` still exists. It is undetermined whether the next compile removes the directory
  entirely or restores the file at a higher version.

## Answered

### room-a-edit-parity: Is room A's `P2A_EDIT_MARKER_room-a-refresh-test` a published Canonical edit?
- Evidence: answered by the Phase2A delete test — the edited file was deleted at 2026-09-18T04:10Z and
  `manifest.documents` no longer contains `branches/hiring-sop.md`, so the edit was never published. See
<!-- openwiki: broken internal link [sources/canonical.md#deletion-in-room-a-branches-hiring-sop-md] heading anchor "deletion-in-room-a-branches-hiring-sop-md" does not exist in "sources/canonical.md". Fix the href or restore the target, then delete this comment. -->
  [sources/canonical.md](sources/canonical.md#deletion-in-room-a-branches-hiring-sop-md).
- Answered: 2026-09-18

## Stale
