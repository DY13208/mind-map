# Collaboration V2 测试清单

审计日期：2026-09-04。项目测试入口为 `simple-mind-map/package.json`，Node 测试位于 `test/`，浏览器测试位于 `e2e/collab-v2/`。PG 不可用的集成/基准测试会显式 skip。

| Test Type | Coverage | Environment | Duration | Stable | Known Issue |
| --- | --- | --- | --- | --- | --- |
| `collabV2.test.js` | Outbox、冲突、同用户多客户端、Undo/Redo、搜索替换 | 内存 socket/store | 秒级 | 本次通过 | cycle 后阻塞已修复 |
| `collabV2.drain.test.js` | blocked queue、cycle、SOP、权限、ACK 查询异常 | 内存 + 子进程 watchdog | 约 1 秒 | 本次通过 | 修复前稳定失败 |
| `exportBackground.test.js` | 背景导出成功及转换/样式异常 | 生产 Export 类 + 依赖 stub | 秒级 | 本次通过 | async executor 挂起已修复 |
| `collabV2.direct.test.js` | Direct store/applier、SQL 范围 | 内存/SQL mock | 秒级 | 是 | 无 |
| `collabV2.features.test.js` | 节点 feature 远端 apply | 内存 socket/store | 秒级 | 待 Freeze 重跑 | 无 |
| `collabInsertCollect`、`collabMove`、`collabDeleteMatrix` | 插入、移动、删除、收集 | 内存 | 秒级 | 待 Freeze 重跑 | 无 |
| `collabPaste`、`collabPasteUndo` | Paste UID、复制/撤销 | 内存 | 秒级 | 待 Freeze 重跑 | 无 |
| `collabNodeFeatures`、`collabMapMetaStyle` | 内容、样式、metadata | 内存 | 秒级 | 待 Freeze 重跑 | 无 |
| `collabGeneralization`、`collabSpecialObjects`、`collabLayoutGhost` | 特殊对象、布局清理 | 内存 | 秒级 | 待 Freeze 重跑 | 无 |
| `collabTreeAuthority`、`roomNodes` | room_nodes 权威、迁移 | 内存/存储 mock | 秒级 | 待 Freeze 重跑 | 无 |
| `collabV2.*.integration` | ACL、IDB、Socket、5 客户端、重连 | PostgreSQL + Socket | 分钟级 | 依赖环境 | PG 缺失时 skip |
| `collabV2.pg.bench` | 1k/5k/10k/20k PG 操作与 hydrate | PostgreSQL | 分钟级 | 非 Freeze | 仅 benchmark |
| `collabV2.soak.integration` | 随机写、重连、hash/listener | PostgreSQL + Socket | 分钟级 | 非 Freeze | 非 30m/1h soak |
| Playwright `e2e/collab-v2` | Smoke、ACL、socket、bench | 浏览器 + 服务 | 分钟级 | 环境依赖 | 不纳入 Node Freeze |

完整测试文件由以下命令可复查：`rg --files test e2e/collab-v2`。本轮不移动既有稳定测试。

修复后补充：runner 中 20 个 Freeze 文件已全部通过。表中此前“待 Freeze 重跑”的记录已由本次重跑补齐；真实 PG/浏览器测试仍未实测，不能据文件存在认定通过。
