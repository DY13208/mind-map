# 依赖清理候选

审计范围：根项目无 `package.json`；实际依赖清单为 `simple-mind-map/package.json` 与 `web/package.json`。

| Candidate | Reason | Required before removal |
| --- | --- | --- |
| `yjs`、`y-webrtc`、`y-websocket` | V1/Yjs compatibility 候选 | 完成 V1 rollback 与生产配置 reachability 审计 |
| `redis` | Outbox redis integration/多实例候选 | 确认部署是否启用 Redis |
| `pg` | V2 权威存储与 benchmark 使用 | 不可删除 |
| `socket.io`、`socket.io-client` | V2 realtime 使用 | 不可删除 |
| debug-only packages | 未在本轮机械判断 | 需 `npm ls` + 静态引用 + 部署清单三方验证 |

本轮不删除依赖，避免破坏 rollback 或部署路径。
