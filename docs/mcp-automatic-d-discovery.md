# 跨脑图查找自动 D 节点

新增 MCP 工具 `list_automatic_d_nodes`，对应只读 API `GET /api/automation/d-nodes`。适用于 AI 定时任务每轮发现候选目标，不负责创建定时任务或执行 SOP。

## 匹配规则

这里的 **D 表示 Do（做）**。两个条件必须同时成立：节点属于既有标题约定 `D：` / `D:` 的 Do 节点，且该节点自身的标题包含“自动”。这是快速发现 D 节点的入口，返回标识与标题预览，详细内容由后续 `query_nodes` 定向读取。

- `D：自动生成日报`、`D: 自动同步库存`、小写 `d:` 均匹配。
- 兼容富文本、HTML 不间断空格、项目符号和 `【D：自动任务】`；`自<strong>动</strong>` 不会因标签被漏掉。
- `D1：自动步骤`、`D2：自动步骤`、普通节点、仅备注或后代出现“自动”的 D 节点均不匹配。
- `C：自动验收`、`P：自动计划`、`A：自动处理` 和普通标题 `自动生成日报` 均不匹配。
- 使用字面匹配，`D：非自动整理` 也会列为候选。标题不是执行授权，AI 必须读取目标内容和 C/P 后再判断如何处理。

## MCP 调用

首个请求：

```json
{"limit":50}
```

响应示意（`room_key` 即 roomid，`uid` 即节点 id；版本号可能为字符串）：

```json
{
  "items":[{
    "room_key":"room-example",
    "room_title":"项目工程",
    "uid":"node-example",
    "parent_uid":"parent-example",
    "text":"D：自动生成日报",
    "text_truncated":false,
    "room_version":"42",
    "node_version":"40",
    "source":"room_nodes"
  }],
  "limit":50,
  "has_more":true,
  "next_cursor":"opaque-cursor-from-server",
  "complete":false,
  "coverage":{"unindexed_room_count":0,"unindexed_room_keys_sample":[]},
  "consistency":"live_keyset",
  "match":{"node_type":"D","field":"title","contains":"自动"}
}
```

`has_more=true` 时，将 `next_cursor` 原样传回，直到 `has_more=false`：

```json
{"limit":50,"cursor":"opaque-cursor-from-server"}
```

默认每页 50 条，允许 1～200。不返回昂贵的全局总数，完整遍历后可累计匹配数。游标有效期 24 小时，绑定调用身份并有签名，不能跨账号或修改；过期、签名不匹配或密钥轮换后会明确报错，应从第一页重新扫描。

随后对每个结果调用现有 `query_nodes`：

```json
{
  "room_key":"room-example",
  "selector":{"type":"uid","value":"node-example"},
  "scope":"subtree",
  "page_size":100
}
```

`query_nodes` 也必须按其 `next_cursor` 继续读取。不要把候选列表的标题预览当作完整 SOP；节点标题预览最多 1024 字符，超出时 `text_truncated=true`，脑图标题最多 512 字符。此接口不返回备注、附件正文或整图数据。

## 权限与翻页一致性

用户凭证只列出该用户有整图查看权限的脑图；管理员及服务凭证沿用现有权限范围。只持节点分享链接不会获得全系统检索权限。每页都重新检查当前 ACL，撤销权限立即影响续页。回收站脑图、永久删除脑图和已删除节点不返回。

HTTP MCP 会话绑定初始化时的凭证（只保存凭证摘要），POST、GET 和 DELETE 均进行一致性检查。更换账号或凭证后需重新 `initialize`；复用其他凭证建立的会话返回 HTTP 403、`MCP_SESSION_AUTH_CHANGED`，不会继续使用原账号权限或关闭原账号会话。合法 Bearer 头的大小写和空白差异不影响同一凭证的会话。

分页按 `(room_key, uid)` 键集排序，编辑标题或更新脑图时间不会造成 offset 式重排。跨页是实时查询，不是跨整个扫描周期的冻结快照：扫描期间新增、删除或重命名的任务可能影响本轮集合。定时任务每轮从首页扫描，轮内按 `(room_key, uid)` 去重，执行前再次读取并检查权限；不要把一个旧游标永久当成增量监听。

旧 `rooms.nodes` JSON 格式在房间从未建立节点表时兼容读取；已经建立过节点表的房间不回退旧快照，避免复活已删除节点。若有仅存 COS、空占位或不可识别格式的脑图，返回 `coverage.unindexed_room_count` 和最多 20 个房间号样本，且 `complete=false`。先通过现有读取/迁移流程建立这些脑图的数据库节点内容，再从首页重扫。不能在 `has_more=false` 但 `complete=false` 时声称覆盖了全部脑图。

历史 JSON 兼容路径需要在数据库中展开旧图，性能不等同于节点表索引；历史图较多时建议先完成节点表迁移。每页查询在只读事务中执行，设置 15 秒语句超时，出错会明确返回，不会把超时当成空结果。

## 部署和验证

后端启动自动创建专用部分索引 `room_nodes_automatic_d_idx`，只收录匹配的有效节点，索引建立采用 `CONCURRENTLY`，避免阻塞正常节点写入。生产环境也可先独立执行 `simple-mind-map/migrations/013_automatic_d_nodes.sql`，**不要放入事务**，再重启协作 API 和 MCP 服务。现有 MCP 会话需要重新连接后才能发现新工具。无需新增业务环境变量，不修改现有客户端配置或生产密钥。

端到端回归脚本：`simple-mind-map/test/automaticDNodes.pg.test.cjs`。仅接受显式配置的本机临时数据库，覆盖匹配边界、旧格式、ACL、权限撤销、删除、完整翻页、游标篡改/过期/身份隔离、真实 HTTP/MCP 发现及续页、用返回 ID 读取子树，以及 5 万节点索引执行计划。临时配置必须包含 `pg`、隔离 API 的 `api` 地址及合成 `mcpToken`，不能使用业务数据库。

```sh
AUTOMATIC_D_TEST_CONFIG=/absolute/path/to/isolated-qa-config.json \
node simple-mind-map/test/automaticDNodes.pg.test.cjs
```

本次本地 5 万节点样本中，候选 SQL 命中了专用部分索引，执行耗时约 0.5ms；这是隔离数据库样本数据，不代表生产端到端延迟。原有 MCP、节点查询和权限回归同时执行；生产数据和真实定时执行仍需部署后验收。

原有 MCP/节点查询测试结果为 15 项通过、4 项既有 TODO，权限与用户令牌测试通过。新模块、MCP 注册和新增测试的 ESLint 通过；`mindApi.js` / `storage.js` 全文件原有的 15 个 lint 问题与基线逐项对比一致，本次未增加。

### 2026-10-28 最新主分支复测

在 `origin/main` 的 `225a5215f` 上复测，D/Do 标题筛选、逐页返回全集及 UID 读取子树均通过。额外的跨账号 HTTP 会话测试复现了会话 ID 未绑定凭证的问题，补修后验证不同账号/服务凭证无法复用已有会话，原会话仍可查询；独立账号只读取自己的结果，跨账号分页游标被拒绝，正常删除会话后旧 ID 失效。

本轮原有回归为 17 项通过、4 项既有 TODO，无失败；隔离 PostgreSQL/API/MCP 端到端全部通过。5 万节点样本命中部分索引，候选 SQL 约 0.46ms，仍不代表生产端到端延迟。测试数据、账号与数据库均为合成的临时环境，未创建或执行真实业务定时任务。
