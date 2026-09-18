---
type: Source
title: Mind Map MCP Source
description: Evidence notes for the custom-mcp Mind Map source instance, including why ow-p2a-room-a and ow-p2a-room-b are absent from its room inventory.
tags: [custom-mcp, mcp, mind-map, source, phase2a]
generated: { by: "openwiki/0.5.2", at: "2026-09-18T04:06:50.177Z" }
---

# Mind Map MCP Source

This is the **Mind Map MCP** source instance (`custom-mcp`), a read-only MCP surface over
Mind Map rooms. It is a separate system from the Canonical publication surface documented in
[sources/canonical.md](canonical.md).

## Configured read-only tools

The connector allows only these four tools; everything else on the server is out of scope for
ingestion.

- `list_maps` — list rooms with titles and share links.
- `get_map` — read a whole room (outline or full).
- `search_nodes` — text search within a room.
- `query_nodes` — targeted reads of a node, its children, a subtree, or a path.

## Coverage for this run

- `list_maps` returned 312 rooms (paginated, `limit` 100, `nextCursor` present).
- Neither `ow-p2a-room-a` nor `ow-p2a-room-b` appears in that inventory.
- A direct `get_map` for `room_key` `ow-p2a-room-a` returned `not found`.

## Conclusion

The Mind Map MCP source contributes **no** content for the two Phase 2A rooms. All room content in
this wiki is therefore grounded in the Canonical source; see
[rooms/ow-p2a-room-a.md](../rooms/ow-p2a-room-a.md) and
[rooms/ow-p2a-room-b.md](../rooms/ow-p2a-room-b.md).
