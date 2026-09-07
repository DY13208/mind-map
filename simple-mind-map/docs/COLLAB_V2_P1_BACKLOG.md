# Collaboration V2 P1 Backlog

Merged from C4 inventory and current main freeze notes. **Do not list closed P0s here.**

| Priority | Item | Notes |
| --- | --- | --- |
| P1 | Large XMind / huge import performance | Product accepted as P1, not freeze-breaker |
| P1 | Generalization extreme drag slot | Renderer edge |
| P1 | Image / AssociativeLine small paint delay | Renderer |
| P1 | Multi-select Style flicker | UI |
| P1 | Renderer Ghost DOM/SVG counts | Browser soak not run (C4) |
| P1 | Socket listener leak on room open/close | Not measured |
| P1 | Timer leak (heartbeat / ack / reconnect) | Not measured |
| P1 | Import/export full format matrix + F5 | Partial tests only; RichText F5 HTML escape is **fixed on main** |
| P1 | Docker / collab restart human QA | Deferred |
| P1 | V1/Yjs cleanup | Inventory only — **do not delete yet** |
| — | Offline-first as product requirement | **Not a requirement** |

Closed (not P1): CYCLE_REJECTED drain hang; Outbox shared-uid false dependency; blocked-queue busy-loop; terminal-create dependency chain; ACK vs counter-refresh ordering; History bootstrap empty-tree replay; File System dual-entity risk.
