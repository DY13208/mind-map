---
type: Guide
title: OpenWiki Quickstart
description: Entry point for this local knowledge wiki, which is a Phase 2A contract test that synthesizes short durable pages from the Canonical knowledge rooms ow-p2a-room-a and ow-p2a-room-b, including the branch-deletion test.
tags: [quickstart, phase2a, canonical, contract-test]
generated: { by: "openwiki/0.5.2", at: "2026-09-18T04:11:06.782Z" }
---

# OpenWiki Quickstart

This wiki is a **Phase 2A contract test**. Its scope is deliberately narrow: synthesize
short, durable Markdown pages from the Canonical knowledge exposed for the two test
rooms `ow-p2a-room-a` and `ow-p2a-room-b`, and preserve each document's source markers.

## What this wiki covers

- Two isolated OpenWiki Output Contract test rooms, both on the topic *Hiring SOP overview*.
- The Canonical publication surface: versioned Markdown documents published by the compiler
  and read through the read-only MCP tools `list_knowledge` and `read_knowledge`.

## Where to start

- [rooms/ow-p2a-room-a.md](rooms/ow-p2a-room-a.md) — test room A: README only; its hiring-sop branch
  was deleted.
- [rooms/ow-p2a-room-b.md](rooms/ow-p2a-room-b.md) — test room B: README plus the surviving hiring SOP.
- [topics/hiring-sop.md](topics/hiring-sop.md) — the Hiring SOP content, now published only by room B.
- [sources/canonical.md](sources/canonical.md) — the Canonical knowledge source: contract, versioning fields, and ingestion coverage.
- [sources/custom-mcp.md](sources/custom-mcp.md) — the Mind Map MCP source instance and why it contributes no room content for these two rooms.

## Current status

- Both target rooms are present in the Canonical knowledge root with `lastCompiledVersion` 1.
- **Phase2A delete test:** room A's `branches/hiring-sop.md` was deleted from disk and from
  `manifest.documents`. `branches/` is empty and room A now publishes only `README.md`, so the SOP
  branch is no longer readable from room A. See [rooms/ow-p2a-room-a.md](rooms/ow-p2a-room-a.md).
- Room B is unchanged: it still publishes `README.md` and `branches/hiring-sop.md` (118 bytes, hash
  matching its manifest), and is now the only canonical copy of the SOP —
  see [topics/hiring-sop.md](topics/hiring-sop.md).
- None of the room A changes (the out-of-band edit, then the deletion) bumped `version`,
  `publicationId`, or `lastCompiledVersion`; only `manifest.documents` and `sourceHash` reflect the
  deletion. Room A's `sourceHash` now equals its README hash.
- The Mind Map MCP room inventory (312 rooms) does **not** contain either target room, so the
  room pages are grounded in Canonical evidence only.
- Evidence for this run came from reading `/knowledge/ow-p2a-room-a` and `/knowledge/ow-p2a-room-b`
  from the filesystem because the `custom-mcp-canonical` tools were unavailable.

## Backlog

- Room set is intentionally limited to `ow-p2a-room-a` and `ow-p2a-room-b`; no other rooms should be
  promoted into this wiki without a new scope instruction.
- Re-check room A on the next run: if the compiler re-publishes the SOP branch, expect
  `manifest.documents["branches/hiring-sop.md"]` to reappear and `version` to exceed 1. If instead the
  deletion is finalized, expect `branches/` to disappear entirely.
- If a later Phase 2A run adds branches or attachments to either room, extend the room pages and re-read
  [sources/canonical.md](sources/canonical.md) for updated versioning metadata.
