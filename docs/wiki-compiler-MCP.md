# wiki-compiler MCP

现有 Knowledge MCP 端点 `/knowledge-mcp/mcp` 新增四个只读工具，沿用同一 Bearer Token、认证、用户限流和审计。

| 工具 | 参数 | 功能 |
| --- | --- | --- |
| `wiki_compiler_graph` | 无 | 主题、概念和关联图谱 |
| `wiki_compiler_search` | `query` 必填；`top_k` 为 1–50；`mode` 为 `business`（默认）或 `demo` | 检索编译小节 |
| `wiki_compiler_topic` | `slug` 必填 | 读取主题全文、小节和元数据 |
| `wiki_compiler_concept` | `slug` 必填 | 读取概念文章 |

先搜索或读取图谱取得 slug，再读取对应文章。返回值保留原 API 的内容、来源和 hash 等字段。

数据范围与 wiki-compiler 图谱页面一致，按调用者实时脑图房间读取权限过滤；通过 MCP 身份认证不代表可以读取所有房间。它复用脑图编译产物，独立于 Docmost 的 `wiki_*` 和另一套 `openwiki_*`。工具不会执行编译或修改 Wiki。

Docker Compose 默认使用 `WIKI_COMPILER_API_URL=http://wiki-graph:3848`。外部网关可设为 `http://主机:端口/wiki-compiler/`。请求超时 10 秒，响应上限 8 MiB；服务不可用、主题不存在或参数错误会返回 MCP `isError`。

部署：`docker compose up -d --build wiki-graph knowledge-mcp`。已有客户端沿用 Knowledge MCP 配置，刷新工具列表即可，无需新增 MCP 服务器。部署前需配置现有 `KNOWLEDGE_MCP_JWT_SECRET`，并确保 `WIKI_COMPILE_DIR` 包含编译产物。

验证：`node --test integrations/knowledge-mcp/tests/*.test.js`。

## 节点附件按需读取

思维导图 MCP 自身提供以下两个工具，不需要新增 Knowledge MCP 配置。只处理 `attachmentId` 节点附件，不处理 `data.knowledgeFiles`。

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `search_attachment_knowledge` | `room_key`、`node_uid`、`query` 必填；`attachment_id` 可选；`top_k` 默认 3，最大 5 | 对应附件已编译正文中的相关片段，每片最多 800 字符，总 JSON 不超过 12 KiB |
| `read_attachment_knowledge` | `room_key`、`node_uid`、`attachment_id` 必填；Wiki 用 `cursor`；原文用返回的续读参数；`length` 默认 4000，最大 10000 | Wiki 优先，缺失时自动返回原附件解析正文的一页，总 JSON 不超过 20 KiB |

服务端分别通过 `POST /api/wiki-compiler/api/attachments/search`、`POST /api/wiki-compiler/api/attachments/read` 代理到 Wiki 服务。请求体使用同名参数。沿用调用者身份和实时房间 ACL；同时验证当前节点挂载关系、房间版本、知识源修订和附件内容哈希。续读游标绑定身份与 Wiki generation，有效期 15 分钟。版本变化或游标不可用返回 `stale`，不能继续拼接旧页。

默认流程是先 `query_nodes` 定位节点，再按任务检索 Wiki，必要时展开指定附件。`query_nodes` 新参数 `attachment_content=metadata|preview`：MCP 默认 `metadata`，不返回 `attachmentExtractedText`；显式 `preview` 可恢复原有预览。通用节点 HTTP 接口省略参数仍保留旧行为，翻页必须保持模式一致。投影不会更改保存数据和字段版本。

Wiki 状态包括 `ok`、`no_match`、`pending`、`processing`、`failed`、`not_synced`、`stale`、`unavailable`、`index_upgrade_required`。未挂载或不存在也会明确返回。`no_match` 不是全文不存在的证明。MCP 内容读取采用 Wiki 优先：首次检索或阅读在 Wiki 无命中、缺正文、过期或不可用时，自动降级调用原附件解析文本接口，返回一页有界内容，标明 `source_backend=attachment` 和 `fallback_reason`。原文预览不是关键词命中证据，不自动扫描或拼接全部附件。附件仍在解析或解析失败时保留实际状态，不触发重新解析。

权限拒绝、来源不存在或已解绑不触发降级。Wiki 续读期间版本变化返回过期状态，不能把新原文自动拼到旧 Wiki 页后。降级后的续读固定走原附件逻辑，每页重新校验挂载与版本；按返回的续读参数继续。底层 Wiki 服务仍只负责 Wiki 内容，自动降级由 MCP 和 SOP 共享编排实现。

原文续读使用 `source_backend=attachment`、`offset`、`expected_content_hash`、`expected_version`；附件元数据提供更新时间时同时传 `expected_attachment_updated_at`。直接使用响应给出的续读参数，禁止把 Wiki cursor 传给原文链路。版本或来源变化返回 `stale` 与 `restart_required`，需要从新版本重新阅读，不能接在旧内容后。

新版索引存在但附件未进入 Wiki 正文时返回 `not_synced` 并提供直读引用，例如部分经过特殊主题重组的内容；不能把 Wiki 视为已经完整覆盖所有附件，也不能靠反复升级索引保证正文一定出现。

`build_sop_context` 响应升级到 `response_version=2`：

- 默认 `attachment_mode=metadata`，附件以 `attachments.references` 返回并按 ID 去重，保留关联 `node_uids`，不自动读取正文。
- `relevant` 必须提供 `query`，在 `attachments.results` 返回最多 5 个 Wiki 片段或明确标记来源的原文降级预览，结果合计不超过 20 KiB。
- `full` 只返回首份附件第一页；继续调用 `read_attachment_knowledge`，读完该附件后再选择下一份。不会把全部正文拼成单次输出。
- 分别检查 `nodes_complete` 和 `attachments_complete`；`complete` 只有两者都满足才为 true。节点采集完整不表示附件读完。旧的 `attachments[]` 全文消费者需改为读取 references/results 并按页处理。

Wiki 正文和低层 `read_attachment` 都复用已保存的解析结果，不在读取时重做 OCR。分页读完仅代表读完现有解析文本，不保证原文件、表格布局或 OCR 内容完整。

### 本地验证与性能基准

新增链路验证命令：`npm --prefix simple-mind-map run test:mcp:attachment-knowledge`。另需运行节点查询、附件读取、知识编译的 PostgreSQL 测试；不得连接业务库执行测试。

`simple-mind-map/test/attachmentQuery.benchmark.cjs` 使用 `ATTACHMENT_QUERY_BENCHMARK_CONFIG` 指定测试配置文件，格式为 `{ "purpose": "disposable-test", "pg": { "host": "127.0.0.1", "port": 25492, "database": "attachment_wiki_test_example", "user": "测试用户", "password": "测试密码" } }`。仅允许本机专用测试库，默认交替测量两种模式各 20 轮，创建随机测试房间并在结束时清理；报告不输出密码。

2026-10-30 本地独立 PostgreSQL 测试库，同一批 20 个节点、每个附件预览 2400 个中文字符、20 轮的结果：

| 指标 | preview | metadata |
| --- | ---: | ---: |
| 每轮全部响应字节数（中位数） | 159311 | 8336 |
| 每轮页数（中位数） | 13 | 1 |
| 全页查询 P50 / P95（毫秒） | 133.77 / 165.57 | 12.91 / 17.27 |
| 每页数据库查询次数 | 8 | 8 |

此基准直接调用节点查询实现并连接真实 PostgreSQL，累计响应字节减少 94.77%。它不包含线上网络、模型推理或 Token 计量，不作为线上速度承诺。SOP 默认零正文读取由自动测试独立断言。

同日真实 PostgreSQL + 本地 HTTP 附件问答对照（同一附件、同一查询、20 轮）：

| 指标 | 原解析正文全部分页读取 | Wiki 定向片段检索 |
| --- | ---: | ---: |
| 每任务 HTTP 请求数 | 4 | 1 |
| 20 轮累计响应字节 | 1129440 | 182580 |
| 每任务 P50 / P95（毫秒） | 43.477 / 65.979 | 22.823 / 26.178 |

原链路基准通过测试 HTTP 适配器调用现有 `getTextSlice`，新链路使用真实 Wiki 附件搜索接口；累计响应字节减少约 83.83%。这是针对相关问题的检索对照，不能替代明确通读任务的全文读取，也不是线上端到端推理耗时。

真实 PG 新链路测试：设置 `MIND_MAP_SKIP_ROOT_ENV=1`、`WIKI_ATTACHMENT_PG_TEST=1` 和本机专用测试库的 `PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD`，再运行 `npm --prefix simple-mind-map run test:mcp:attachment-knowledge:pg`。测试在随机 schema 内验证编译、实时权限、同附件多挂载、预算、版本变化、分页与单房间 CLI 索引升级；结束后清理该 schema。

本次本地验收已通过节点查询 PG、原附件读取 PG、知识编译 PG（27 场景）、WikiCompiler 原 PG 集成、新附件 PG 链路及 MCP 注册测试。目标环境部署、目标房间索引升级与四条实际 Agent 阅读流程仍须单独验收，不能由本地测试代替。
