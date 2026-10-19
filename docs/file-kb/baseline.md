# File KB 阶段 1 基线（改动前记录）

记录时间：2026-10-16 16:05–16:12（UTC+8），机器 D:\mind-map。

## Git
- HEAD：`1caebf9a069e9963431c01ccb66d32e03e30b2e1`
- `git status --short`（KB 工作开始前）：
  - 已修改（与 KB 无关，他人未提交改动，未触碰）：web/src/components/NotchWing.vue、web/src/pages/Edit/components/{Count,NavigatorToolbar,SidebarTrigger,Toolbar}.vue、web/src/pages/ProductShell/FilesPage.vue、web/src/pages/ProductShell/components/{RoomCard,RoomList}.vue、web/src/style/notch.less
  - 未跟踪：`knowledge-service/`（另一套并行实现，见下文“冲突”）
- 预检：仓库内无 `services/`、无 `web/src/features/knowledge-base/`；`docling` / `/api/kb` / `kb_app` / `schema kb` 在已跟踪代码中无命中。

## Compose 服务与端口（docker-compose.yml，宿主机映射）
| 服务 | 映射 |
|---|---|
| postgres 16-alpine | 127.0.0.1:15432→5432 |
| redis 7-alpine | 127.0.0.1:16379→6379 |
| app（nginx:80 + collab 1234 + mcp 3847 + ai） | 8990→80 |
| openclaw-gateway | 127.0.0.1:4623→18789 |
| knowledge-mcp | 127.0.0.1:18792→18792 |
| wiki-graph | 仅内部 3848 |
| tls（nginx） | 8989→443 |
| docker-compose.wiki.yml：docmost / docmost-db / docmost-redis / wiki-gateway / openwiki-runtime | 见该文件 |

当时 `docker compose ps`：app、postgres、redis、knowledge-mcp、wiki-graph、docmost* 均 healthy；`wiki-gateway` 处于 Restarting(1)（与 KB 无关，已存在问题）。

## HTTP 路由（collabServer.js 链 + 各模块，前缀）
`/api/access-requests /api/artifacts /api/attachments /api/auth /api/chat /api/collab-v2 /api/dashboards /api/diagnostics /api/files /api/folders /api/health /api/knowledge /api/local-knowledge /api/mcp-config /api/mcp-oauth /api/node-shares /api/notifications /api/openclaw /api/ops /api/pages /api/sop-ledger /api/spaces /api/teams /api/users /api/wecom /api/wiki-compiler`
nginx 其他入口：`/health /.well-known/oauth-authorization-server /oauth/callback /collab-v2 /socket.io /collab/ /mcp /knowledge-mcp/ /ai/ /yiran/ /jobhub/ /bridge/ /wb-api/ /openclaw-api/ /openclaw-bridge/ /cognee-api/ /wiki-compiler/`。
`/api/kb/*`、`/file-kb-mcp/` 改动前不存在（落入通用 `/api/` → collab 返回 401/404）。

## 现有 MCP 端点
- `/mcp` → app 内 mcpServer.mjs（127.0.0.1:3847，Streamable HTTP + OAuth/MCP token）
- `/knowledge-mcp/` → knowledge-mcp:18792（Wiki，JWT）
- 本阶段对二者零改动。

## web/tests 基线（`node --test web\tests\<file>` 逐个运行）
共 46 个 `*.test.cjs`：**33 通过，13 失败（既有失败，非 KB 引起）**。
失败：cardPreviewQueue、contextmenu.component、cpdCheckApi、editorProductShell.integration、fileApi.replaceFileTree、instantRoomOverview、mapNavTrail、parseClipboardTree.browser、productShell.realApi、productShell.router、productShell.sidebar、run-history-menu、toolbar-run-icon-spin。
通过：attachmentUploadQueue、boundedAttachmentRead、collab-draft-fallback、contextmenu-ai-copy、contributionSkyline、cpdCheckPanel.component、displayName、fileApi.subtreeLifecycle、generalization-run.component、historyAttribution.component、historyOverview、historyPreview.browser、job-history.component、job-hub、job-result-full-output、job-result-structure、job-target-host、login-grid-background、mentionFormat、menuPlacement、mindmap-run-prompt、nodeAttachmentActions、nodeAttachmentPreview.component、nodeAttachmentPreview、nodeCommentCard.component、nodeHyperlinkPopover.component、nodeKnowledge、productShell.openRoom、productShell.services、run-channel-setting、sopRunAttachments、teamRoomsPaging、wecom-login-theme。

## 前端构建基线
`cd web; $env:NODE_OPTIONS='--openssl-legacy-provider'; npx vue-cli-service build --dest $env:TEMP\mm-build-check` → exit 0，`Build complete`（约 110s）。
