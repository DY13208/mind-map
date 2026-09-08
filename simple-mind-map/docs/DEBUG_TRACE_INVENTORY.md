# Debug / Trace Inventory

已检索 `bin/`、`src/`、`test/` 中 `__*_TRACE`、`COLLAB_V2_TRACE`、console 与 diagnostic。

| 分类 | 位置 | 建议 |
| --- | --- | --- |
| 生产诊断保留 | `bin/collabV2/trace.js`、`adapter.js`、`sequencer.js`、`slowPath.js` | 保留，限制 ring-buffer 容量与敏感字段 |
| 树权威 guard | `bin/roomNodes.js`、`bin/storage.js` | 必须保留 |
| 前端协作 trace | `src/utils/collabTrace.js`、`src/plugins/Cooperate.js` | Freeze 后按开关与采样复核 |
| 仅测试 | `test/collabV2.test.js` 的 `TEST_HANG_TRACE` | 保留作 test harness，不进入业务包 |
| 待归类 | `console.*` 位于 `mindApi`、`collabServer`、`Export` 等 | 不在本轮删改 |

`TEST_HANG_TRACE=1` 会显示 case 与 operation 边界；Freeze runner 另有进程级超时。
