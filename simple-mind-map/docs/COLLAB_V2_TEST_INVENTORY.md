# Collaboration V2 测试清单

Current: 2026-09-04. Freeze authority: `docs/COLLAB_V2_FROZEN.md` (`COLLABORATION_V2_CORE_FROZEN = YES`).

`npm run test:collab:v2:freeze` → `scripts/runCollabSuite.js freeze`（main 原 Freeze 文件 ∪ C4 drain/export）。另有 `test:collab:history`、`test:collab:files`。

| Test Type | Coverage | Notes |
| --- | --- | --- |
| `collabV2.test.js` | Outbox、冲突、多客户端、Undo/Redo | Hang wrapper + per-case timeout from C4 |
| `collabV2.drain.test.js` | CYCLE_REJECTED 后 delete drain、SOP、FORBIDDEN | Against **current main** created-UID dependency |
| `exportBackground.test.js` | SVG 背景导出 | C4 |
| Remaining Node freeze files | Direct/features/move/delete/paste/authority/ACL/outbox | Unchanged from main |
| History / File System | Separate scripts | Not in freeze suite |
| Integration / PG / Playwright | Environment-dependent | Not required for Node freeze |

`COLLAB_V2_TEST_FREEZE_READY = YES`
