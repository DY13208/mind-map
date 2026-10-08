# wiki-compiler MCP

现有 Knowledge MCP 端点 `/knowledge-mcp/mcp` 新增四个只读工具，沿用同一 Bearer Token、认证、用户限流和审计。

| 工具 | 参数 | 功能 |
| --- | --- | --- |
| `wiki_compiler_graph` | 无 | 主题、概念和关联图谱 |
| `wiki_compiler_search` | `query` 必填；`top_k` 为 1–50；`mode` 为 `business`（默认）或 `demo` | 检索编译小节 |
| `wiki_compiler_topic` | `slug` 必填 | 读取主题全文、小节和元数据 |
| `wiki_compiler_concept` | `slug` 必填 | 读取概念文章 |

先搜索或读取图谱取得 slug，再读取对应文章。返回值保留原 API 的内容、来源和 hash 等字段。

数据范围与 wiki-compiler 图谱页面一致，是共享公司编译库，不按 roomId 隔离；任何通过现有 Knowledge MCP 身份认证的调用者均可读取。与按 Docmost 权限读取的 `wiki_*`、按房间权限读取的 `openwiki_*` 工具不同。工具不会执行编译或修改 Wiki。

Docker Compose 默认使用 `WIKI_COMPILER_API_URL=http://wiki-graph:3848`。外部网关可设为 `http://主机:端口/wiki-compiler/`。请求超时 10 秒，响应上限 8 MiB；服务不可用、主题不存在或参数错误会返回 MCP `isError`。

部署：`docker compose up -d --build wiki-graph knowledge-mcp`。已有客户端沿用 Knowledge MCP 配置，刷新工具列表即可，无需新增 MCP 服务器。部署前需配置现有 `KNOWLEDGE_MCP_JWT_SECRET`，并确保 `WIKI_COMPILE_DIR` 包含编译产物。

验证：`node --test integrations/knowledge-mcp/tests/*.test.js`。
