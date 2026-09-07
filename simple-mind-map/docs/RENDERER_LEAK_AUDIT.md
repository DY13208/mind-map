# Renderer Leak Audit

本轮新增的是可复用的测试分层与 Node 进程级 hang guard；未运行浏览器 renderer soak，因此以下为审计基线，不宣称已通过泄漏验证。

| Target | Existing evidence | Required soak assertion | Status |
| --- | --- | --- | --- |
| Layout switch ×20 | `collabLayoutGhost.test.js` | 业务 node/DOM group/SVG connector/cache 不单调增长 | 未执行 |
| Move ×50、Delete/Undo ×50 | `collabMove`、`collabDeleteMatrix` | nodeCache、renderTree、uid map 清除并能 restore | 未执行 |
| Generalization / AssociativeLine | `collabGeneralization`、`collabSpecialObjects` | helper/placeholder 不进入 `room_nodes`，SVG 可回收 | 未执行 |
| room open/close ×20 | socket/IDB integration | operation/ack/presence/sync/reconnect listener 不增加 | 未执行 |
| Timer | `adapter` heartbeat、ack/reconnect/presence | room unmount 后无业务活跃 timer | 未执行 |

`test:collab:v2:soak` 现为 PG/Socket 随机操作骨架，不应替代所列 30m/1h 浏览器指标。后续需要在浏览器 harness 中采集 DOM、SVG、listener、timer 与 memory 基线。
