---
type: Guide
title: OpenWiki Quickstart
description: Entry point for this local knowledge wiki, which is a Phase 2A contract test that synthesizes short durable pages from the Canonical knowledge rooms ow-p2a-room-a and ow-p2a-room-b.
tags: [quickstart, phase2a, canonical, contract-test]
generated: { by: "openwiki/0.5.2", at: "2026-09-18T04:09:50.207Z" }
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

- [rooms/ow-p2a-room-a.md](rooms/ow-p2a-room-a.md) — test room A: README, hiring SOP, and unique marker.
- [rooms/ow-p2a-room-b.md](rooms/ow-p2a-room-b.md) — test room B: README, hiring SOP, and unique marker.
- [topics/hiring-sop.md](topics/hiring-sop.md) — the shared Hiring SOP content that both rooms publish, including how the two copies differ.
- [sources/canonical.md](sources/canonical.md) — the Canonical knowledge source: contract, versioning fields, and ingestion coverage.
- [sources/custom-mcp.md](sources/custom-mcp.md) — the Mind Map MCP source instance and why it contributes no room content for these two rooms.

## Current status

- Both target rooms are present in the Canonical knowledge root with `lastCompiledVersion` 1.
- Each room publishes exactly two documents: `README.md` and `branches/hiring-sop.md`.
- The Mind Map MCP room inventory (312 rooms) does **not** contain either target room, so the
  room pages are grounded in Canonical evidence only.
- **Phase 2A refresh:** room A's branch now carries the extra marker
  `P2A_EDIT_MARKER_room-a-refresh-test` under a `## Phase2A edit` heading. The edit happened after
  publication and the manifest was not re-versioned, so the room hash and the publication metadata
  disagree — see [sources/canonical.md](sources/canonical.md). Room B is unchanged.
- This refresh was made by reading `/knowledge/ow-p2a-room-a` and `/knowledge/ow-p2a-room-b` from the
  filesystem because the `custom-mcp-canonical` tools were unavailable.

## Backlog

- Room set is intentionally limited to `ow-p2a-room-a` and `ow-p2a-room-b`; no other rooms should be
  promoted into this wiki without a new scope instruction.
- Re-check room A's `branches/hiring-sop.md` and `manifest.json` on the next run: if the compiler
  re-publishes, expect `version` ≥ 2 and a `fileHash` matching the 167-byte edited document.
- If a later Phase 2A run adds branches or attachments to either room, extend the room pages and re-read
  [sources/canonical.md](sources/canonical.md) for updated versioning metadata.
