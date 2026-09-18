---
type: Source
title: Canonical Knowledge Source
description: Evidence notes for the Canonical knowledge source that publishes versioned Mind Map Markdown documents for ow-p2a-room-a and ow-p2a-room-b, including the Phase2A delete test.
resource: /knowledge
tags: [canonical, source, mcp, phase2a, versioning, deletion]
generated: { by: "openwiki/0.5.2", at: "2026-09-18T04:11:06.782Z" }
---

# Canonical Knowledge Source

The Canonical knowledge source is the compiler-owned publication surface for Mind Map rooms.
This page records what it exposes for the two Phase 2A test rooms; the durable room content
lives on [rooms/ow-p2a-room-a.md](../rooms/ow-p2a-room-a.md) and
[rooms/ow-p2a-room-b.md](../rooms/ow-p2a-room-b.md).

## Read-only contract

- Transport: stdio MCP server `canonical-knowledge` (script `canonical-mcp.cjs`).
- Allowed tools: `list_knowledge` (metadata only) and `read_knowledge` (one versioned document).
- Root of published output: `/knowledge/<roomId>/`.
- `list_knowledge` returns, per room, `roomId`, `version` and the list of document keys.
- `read_knowledge` accepts `roomId` plus a `file`, and only serves `README.md` or a path matching
  `branches/<name>.md`. Documents larger than 2 MiB are rejected.
- Reads are guarded against concurrent changes: the call re-checks the manifest and the document
  `fileHash` and returns `Knowledge changed during read; retry` if anything moved.
- If a `.transaction` file is present in a room directory the server reports
  `Knowledge publication pending; retry`, so a room is only readable once publication settles.

## Versioning fields (per room `manifest.json`)

- `lastCompiledVersion` / `version` / `syncVersion` — publication version counters.
- `publicationId` — identity of the published snapshot.
- `lastSourceRevision` / `sourceUpdatedAt` — the source revision the snapshot came from.
- `sourceHash` — hash of the room source.
- `documents.<file>.fileHash` and `documents.<file>.bytes` — per-document integrity metadata.
- `machineOwned: true`, `strategy: first_level_uid`, `exportContract: 1` — output contract markers.

## Coverage for this run (Phase2A delete test)

| Room | Version | Source updated | Documents | Markers |
| --- | --- | --- | --- | --- |
| `ow-p2a-room-a` | 1 | 2026-09-18T04:01:04.1124944Z | `README.md` only — `branches/hiring-sop.md` deleted | none for the branch; `P2A_MARKER_ow-p2a-room-a` is historical only |
| `ow-p2a-room-b` | 1 | 2026-09-18T04:01:04.1865264Z | `README.md`, `branches/hiring-sop.md` (118 bytes) | `P2A_MARKER_ow-p2a-room-b` |

## Deletion in room A (`branches/hiring-sop.md`)

Room A's branch is gone from both the filesystem and the manifest:

- `/knowledge/ow-p2a-room-a/branches/` exists but is **empty** (directory mtime 2026-09-18T04:10Z).
- `manifest.json` mtime is 2026-09-18T04:11:01Z; `documents` now contains only `README.md`
  (123 bytes, `fileHash` `2ab37b56961284ba2206253eb0566b4d53b331e0797eacb69d56c0877be8cdd1`, matching
  the file on disk). There is no `branches/hiring-sop.md` key.
- `sourceHash` was rewritten to `2ab37b56961284ba2206253eb0566b4d53b331e0797eacb69d56c0877be8cdd1`, i.e.
  it now equals the README hash.
- `version`, `lastCompiledVersion`, `syncVersion`, `publicationId`
  (`de4595f0-a8aa-4ab0-b51c-44ae2919dfbf`), `lastSourceRevision`, `sourceUpdatedAt`, and
  `lastCompiledAt` are all **unchanged** from the original publication.

This removes the earlier edit-vs-manifest divergence for room A: the 167-byte out-of-band edit
documented in the previous run was never published, and the file that carried it no longer exists.
Confidence: **confirmed** for the deletion (empty directory plus rewritten `documents` map); the
deleted 167-byte content is unrecoverable from Canonical and is recorded only as history on
[rooms/ow-p2a-room-a.md](../rooms/ow-p2a-room-a.md).

Room B is untouched: its branch file is still 118 bytes with sha256
`de49362fc633736df95207a79733b2fa5921a98069d19c11fffeafadc01afed1`, matching
`manifest.documents["branches/hiring-sop.md"]`. `custom-mcp-canonical` MCP tools remained unavailable,
so evidence again came from shell reads of `/knowledge/<roomId>/` rather than
`list_knowledge` / `read_knowledge`.

## Notes

- Both rooms publish byte-identical `README.md` structure but different `sourceHash`, `publicationId`,
  `roomId`, and unique marker — the contract test distinguishes rooms by marker, not by SOP body.
  After the delete test, only room B still publishes the SOP branch.
- `manifest.documents` is the authoritative list of what a room publishes: in room A, neither the
  out-of-band edit nor the deletion changed `version`, so `version` alone cannot be used to detect
  document removal. See the room-page history on
  [rooms/ow-p2a-room-a.md](../rooms/ow-p2a-room-a.md).
- The Mind Map MCP source instance does not contain these rooms; see
  [sources/custom-mcp.md](custom-mcp.md).
