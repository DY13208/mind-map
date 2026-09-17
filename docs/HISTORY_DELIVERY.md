# History V2 交付记录

日期：2026-09-17

## 已完成

- Schema 2 迁移（旧表探测/重命名、legacy 映射、结构版本门禁、孤儿快照跳过）
- 去掉全局 `_tx`；checkpoint 同快照；房间级 `onCommitted` 串行
- 恢复：锁外重建 + 短事务、幂等键、body 不能覆盖目标、hidden 404、outbox/`pg_notify`、`restore_epoch_revision`
- 自动版本与 200 次 checkpoint 解耦（idle 2 分钟 / 上限 15 分钟），IMPORT / 初始 / PRE_RESTORE / RESTORE
- 统一 `HistoryPanel`：只读预览、时间线、编辑器入口、恢复确认、实例 `destroy()`

## 测试

| 项 | 结果 |
|---|---|
| `simple-mind-map/test/collabHistory.test.js` | 通过 |
| `simple-mind-map/test/collabHistory.pg.test.js` | 本机第一次跑通（4 条旧快照、legacy tree、幂等恢复、hidden 404）；随后因连接池未退出偶发 skip |
| `simple-mind-map/test/collabHistory.perf.test.js` | 见下 |
| `web/tests/productShell.realApi.test.cjs` | 通过 |
| `simple-mind-map/test/roomAcl.test.js` | 通过 |

内存性能（非 PG 热路径）：

| 规模 | 列表 p95 | tree p95 | 提交回调 p95 |
|---|---|---|---|
| 1,000 | 3.6ms | 21ms | 6ms |
| 10,000 | 35ms | 197ms | 64ms |
| 20,000 | 120ms | 430ms | 186ms |

列表预算 ≤500ms、1 万节点 tree ≤2s：内存重建达标。

## 未达 / 待重启后验证

1. **本机 `http://127.0.0.1:8989` 仍是旧进程与旧前端包**。文件列表「历史版本」仍是窄列表（查看 / revision 文案），API 列表也没有 `summaryText` / `editors` / `capabilities`。需要重启 collab 并重新构建 web 后才是新界面。
2. **双客户端 `map.replaced` 全量 reload、离线 op 不覆盖**：服务端 `restore_epoch` 与客户端 quarantine 已接线；未在两个浏览器会话上用新包跑通。
3. **PG 热路径普通提交 p95 增幅 ≤10%**：未在重启后的真实 `commitDirect` 上对比改动前基线。
4. Playwright `productShell.browserSmoke.cjs` 因本机未安装 `playwright` 包未跑。

## 启用步骤

```bash
node simple-mind-map/bin/migrateHistory.js
# 重启 collabServer
# 重新构建 / 启动 web
```

回退见 [HISTORY_UPGRADE.md](./HISTORY_UPGRADE.md)。
