# V1 / Yjs 技术债清单

| 分类 | Evidence | 处理 |
| --- | --- | --- |
| A. V2 运行中兼容调用 | `bin/storage.js:920-1004,1493` 的 persistence/presence 路径 | Freeze 后以运行配置和调用图复核 |
| B. V1 rollback 仍需 | `src/plugins/Cooperate.js:391-392,786`、`src/plugins/cooperateYjs.js` | 不删除 |
| B. V1 测试仍需 | `test/collabYjs.test.js`、旧 websocket/integration tests | 不删除 |
| C. 可冻结后候选 | `bin/mindApi.js:2220-2221` 标注的 V1 leftover save-status | 先补 production reachability 证据 |
| D. 不确定 | `bin/collabYjs.js`、`bin/mindDoc.js` 的 legacy helper | 不删除，待配置矩阵验证 |

本轮只建清单，未删除 V1/Yjs 代码。
