# 依赖清理候选

**Do not `npm uninstall` in this phase.** Input for a future V1 cleanup.

| Candidate | Reason | Required before removal |
| --- | --- | --- |
| `yjs`、`y-webrtc`、`y-websocket` | V1 compatibility | Rollback + production reachability |
| `redis` | Optional outbox bus | Confirm deploy uses Redis |
| `pg` | V2 authority | Never remove |
| `socket.io` / `socket.io-client` | V2 realtime | Never remove |
