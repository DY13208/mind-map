---
type: Knowledge Room
title: Test Room ow-p2a-room-a
description: Canonical knowledge room ow-p2a-room-a, a Phase 2A Output Contract test room on the Hiring SOP overview topic.
resource: /knowledge/ow-p2a-room-a
tags: [phase2a, canonical, test-room, hiring-sop]
generated: { by: "openwiki/0.5.2", at: "2026-09-18T04:09:50.207Z" }
---

# Test Room ow-p2a-room-a

**Room label:** Phase2A Test Room ow-p2a-room-a
**Topic:** Hiring SOP overview
**Source:** Canonical publication surface — see [sources/canonical.md](../sources/canonical.md)

## README.md (verbatim summary)

> `# Phase2A Test Room ow-p2a-room-a`
>
> This is an isolated OpenWiki Output Contract test room.
> Topic: Hiring SOP overview.

## branches/hiring-sop.md

Full SOP body: [topics/hiring-sop.md](../topics/hiring-sop.md).

- Steps: 1) Intake resume, 2) Screen, 3) Interview.
- **Unique marker:** `P2A_MARKER_ow-p2a-room-a`
- **Phase2A refresh marker:** `P2A_EDIT_MARKER_room-a-refresh-test` — added under a `## Phase2A edit`
  heading below the original body, so this copy is now **longer than** room B's.

## Publication metadata

- Version 1, `publicationId` `de4595f0-a8aa-4ab0-b51c-44ae2919dfbf`
- `sourceUpdatedAt` 2026-09-18T04:01:04.1124944Z
- `manifest.json` still records `branches/hiring-sop.md` as 118 bytes with
  `fileHash` `9ebb50c5bcb4cf30b45611bfd43cdf23ba0e8eddff8a7eda89db0e38e5b472d6`.

## Edit-vs-manifest divergence

The on-disk `branches/hiring-sop.md` was edited directly after publication
(file mtime 2026-09-18T04:09:47Z, 167 bytes, sha256
`e171bcb6397e8d3ab0ab23af68ab512e97e22fdea71fab13b01dc16702cf729c`). It therefore no longer matches
the `fileHash`/`bytes` recorded in `manifest.json`, and `version`/`publicationId` were **not**
bumped. Under the read-only contract in [sources/canonical.md](../sources/canonical.md), a
`read_knowledge` call would detect this hash mismatch. The new marker is confirmed by direct
directory read, and is **not** independently confirmed as published Canonical output.
