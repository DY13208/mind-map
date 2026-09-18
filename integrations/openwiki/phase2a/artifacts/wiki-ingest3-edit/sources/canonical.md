---
type: Source
title: Canonical Knowledge Source
description: Evidence notes for the Canonical knowledge source that publishes versioned Mind Map Markdown documents for ow-p2a-room-a and ow-p2a-room-b.
resource: /knowledge
tags: [canonical, source, mcp, phase2a, versioning]
generated: { by: "openwiki/0.5.2", at: "2026-09-18T04:09:50.207Z" }
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

## Coverage for this run (Phase 2A refresh)

| Room | Version | Source updated | Documents | Markers |
| --- | --- | --- | --- | --- |
| `ow-p2a-room-a` | 1 | 2026-09-18T04:01:04.1124944Z | `README.md`, `branches/hiring-sop.md` (167 bytes on disk) | `P2A_MARKER_ow-p2a-room-a`, `P2A_EDIT_MARKER_room-a-refresh-test` |
| `ow-p2a-room-b` | 1 | 2026-09-18T04:01:04.1865264Z | `README.md`, `branches/hiring-sop.md` (118 bytes) | `P2A_MARKER_ow-p2a-room-b` |

## Unpublished edit in room A

`/knowledge/ow-p2a-room-a/branches/hiring-sop.md` was modified on disk at 2026-09-18T04:09:47Z, after
publication (`lastCompiledAt` 2026-09-18T04:01:04.1155023Z). Its sha256 is
`e171bcb6397e8d3ab0ab23af68ab512e97e22fdea71fab13b01dc16702cf729c`, while `manifest.json` still records
`fileHash` `9ebb50c5bcb4cf30b45611bfd43cdf23ba0e8eddff8a7eda89db0e38e5b472d6` and `bytes` 118.
`version`, `lastCompiledVersion`, and `publicationId` remain at 1 / 1 /
`de4595f0-a8aa-4ab0-b51c-44ae2919dfbf`. Room B's manifest hash and file hash still match
(`de49362fc633736df95207a79733b2fa5921a98069d19c11fffeafadc01afed1`, 118 bytes).

- Confidence: the marker is **source-backed** via direct directory reads; its status as published
  Canonical output is **unconfirmed** because the snapshot metadata was not updated with it.
- `custom-mcp-canonical` MCP tools were unavailable during this refresh, so evidence came from shell
  reads of `/knowledge/<roomId>/` rather than `list_knowledge` / `read_knowledge`.

## Notes

- Both rooms publish byte-identical structure but different `sourceHash`, `publicationId`,
  `roomId`, and unique marker — the contract test distinguishes rooms by marker, not by SOP body.
  After the refresh, room A's branch is also longer than room B's.
- The Mind Map MCP source instance does not contain these rooms; see
  [sources/custom-mcp.md](custom-mcp.md).
