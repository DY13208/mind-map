# Collaboration V2 Freeze Report

审计日期：2026-09-04。后续用户已明确授权修复此前失败，本报告同步记录修复后的验证结果。

| Area | Result |
| --- | --- |
| Freeze Test | 20 个测试文件全部通过，包含原 collabV2 套件与新增 drain / export 回归 |
| Integration Test | 已新增 `test:collab:v2:integration` 分层入口 |
| Benchmark | 已新增 `test:collab:v2:benchmark`，复用 PG benchmark |
| Soak / Leak | 保留 `test:collab:v2:soak`；renderer 泄漏量测待补 |
| collabV2.test.js Hang Root Cause | 已稳定复现并修复；见下方历史记录与修复说明 |
| Tree Authority | 静态审计为 `room_nodes` 单权威，legacy fallback 受迁移 guard 限制 |
| Full-tree mutation | 静态审计：普通操作有 guard；受控 replace 限 import/recovery |
| ACL / Outbox / Undo / Redo / Special Objects | Node Freeze 内相关测试已通过；真实 PG/浏览器验证未执行 |
| Import / Export | 新增背景导出成功/失败回归；全格式/F5 验证未执行 |

## P0_FOUND（修复前记录，现已关闭）

修复前稳定复现：运行 Freeze，trace 固定停在：

1. `ThreeClientsAndConflicts` 中 A 的 `node.move n1` 触发 `CYCLE_REJECTED`；
2. B 的正常 `node.move n3` 成功；
3. A 的 `node.delete n3` 开始后永不完成。

精确根因：`dependsOnBlockedOp` 把失败操作的 parent 引用当作依赖目标，且序号判定被提前 return 短路；`pickDrainHead` 排除了被阻塞的 pending，但 `kickDrain` 仅看是否存在任意 pending 就立即重入，形成无可发送工作时的微任务自旋。这不只是遗漏 terminal 分类造成的问题。

修复：重入复用 `pickDrainHead`，无可发送 head 时停下；依赖采用目标 UID 与后续 clientSeq，独立兄弟节点不互相阻塞；被拒绝的 cycle move 隔离且不阻塞后续写入；FORBIDDEN 保持停止自动 drain。成功 ACK 在返回调用方前完成保存状态和 Undo 栈更新，统计查询失败不会使 ACK 等待永久挂起。

回归：`test/collabV2.drain.test.js` 在修复前由外部 watchdog 稳定报 ETIMEDOUT，修复后 7 个独立用例通过，覆盖阻塞队列让出事件循环、独立任务继续、cycle 后删除、SOP 隔离、FORBIDDEN、依赖方向/序号及成功/失败 ACK 遇统计查询异常。原 `ThreeClientsAndConflicts` 及整个 `collabV2.test.js` 也通过。

Lint 修复：70 项错误已清零，未禁用 lint 规则。重复函数只删除被覆盖的旧声明；双端 CommonJS 工具增加精确全局声明；导出背景函数去除 async Promise executor，转换/样式失败会正确 reject，并新增 `exportBackground.test.js`。

## Test Commands

```text
npm run test:collab:v2:freeze
npm run test:collab:v2:integration
npm run test:collab:v2:benchmark
npm run test:collab:v2:soak
```

## Build / Test Result

- Freeze：20 个文件全部通过，包含 7 个新增 drain 回归及背景导出测试。
- `npm run lint`：通过，0 error。
- Integration / Benchmark / Soak：本次未执行，不算 PASS，也不再被上述 P0 阻挡。
- 生产构建：通过，退出 0；仅有资源包体积警告。已补齐本地缺失的已锁定依赖 `socket.io-client@4.8.1`，未修改 package/lock 依赖清单。
- 构建验证命令（web 目录）：`node node_modules/@vue/cli-service/bin/vue-cli-service.js build --dest <临时构建目录>`，使用与正式构建相同的生产配置；未执行覆盖根 index.html 的 copy 发布步骤。
- Collaboration Core Modified = YES（用户追加授权的局部修复）
- Database Schema Modified = NO（无需迁移脚本）

`COLLAB_V2_FREEZE_P0 = 0`（本次已定位问题均关闭，不代表未执行场景没有未知问题）

`NODE_FREEZE_SUITE = PASS`

`COLLAB_V2_TEST_FREEZE_READY = NO`

完整专项验收仍缺真实 PG/Realtime/F5 和浏览器资源泄漏实测证据。上轮把 P0 写成“唯一阻塞项”不够准确：它是当时已复现的代码阻塞，但未执行项目不能因此计为已验收。Node Freeze 已通过；完整验收暂不放行。
