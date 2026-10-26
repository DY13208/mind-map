# MCP 批量接口与删除子树 token 修复

## 原因与变更

- 运行容器的 `COLLAB_MCP_DIRECT`、`COLLAB_V2_EVENT_BRIDGE` 均为 false；本地 `.env` 已为 true，但未应用。`apply_nodes` 不支持 legacy 回退，因此批量失败而单项可写。
- legacy 删除会全量写回剩余节点，原 upsert 无条件覆盖所有 `node_version`，导致无关分支 token 失效。
- `roomNodes.js` 现在仅在 parent、position、data、根身份或删除状态实际变化时更新版本；未变化节点保留版本。根节点预降级只针对不同 UID 的旧根，避免每次写入都人为改变当前根身份。token 算法与冲突校验保持原样。
- Compose 默认开关仍为 false。此次部署应用已有 `.env` 中的两个 true，并保留两项存在配置漂移的运行密钥，未将无关密钥变化带入重建。

## 验证

- `node scripts/mcp-legacy-node-versions.pg.cjs`：真实 PostgreSQL 临时表，先复现全量写回导致版本全部变化，再验证修复后的无变化写回、兄弟删除、后代修改、移动、恢复和换根。
- `node scripts/mcp-guards-browser.cjs --api-check --compat-mode --delete-token-only`：真实 native MCP + 独占 10,000 节点测试库；原 B token 在删除 A 后可直接删除 B；后代修改导致旧 token 拒绝且不增修订。结果 `output/mcp-write-guards/c632062f7f09/summary.json`。
- Direct 原生接口完整回归通过：`output/mcp-write-guards/83723fda3e12/summary.json`。Direct token 专项通过：`output/mcp-write-guards/67b8c6149724/summary.json`。
- 使用候选 Docker 镜像提取的前端产物，运行 `--delete-token-check` 完整浏览器验收：三个真实 Chrome 会话、独占 10,000 节点图，25 项通过，测试库已清理。覆盖批量、单版本、重放、冲突、实时收敛、草稿刷新恢复和断线追赶。结果 `output/mcp-write-guards/f6ea9eb966de/summary.json`。
- Direct policy、真实入口、批次事件桥专项均通过。
- 综合旧回归 23 个脚本中 20 个通过。3 个失败在加载 HEAD 原始 `roomNodes.js` 时同样复现：remote-render 的 `markRemote` 未定义、Reliability 的 `assert.ok(opSend)`、HttpHistoryRefresh 的 VM 提取代码 SyntaxError。本次不扩展修改这些现有失败。基线日志在 `output/mcp-fix-baseline-*.log`。
- `git diff --check` 与语法检查通过；Docker 完整构建成功。

## 部署与生产证据

2026-10-26 15:22（上海时间）仅重建 `app`，运行健康，两个开关为 true。没有提交或推送 Git，没有修改既有业务图。

- 候选/运行镜像：`mind-map-app:mcp-fix-20261026`，ID `sha256:e74448e2f39fcfb673b7c3739ab566c7055e4ed90fa7708b48849efb224cdf02`。
- 旧镜像保留为 `mind-map-app:before-mcp-fix-20261026`，ID `sha256:56a03cf01c1ce9940ab5f3d4aa378a3d4d9c0e08eca21c1bb9f3be4c7a03d5d8`。
- 部署记录 `output/mcp-fix-deploy.json`；构建记录 `output/mcp-fix-20261026-build.log`。
- 生产 native HTTP MCP `http://127.0.0.1:8990/mcp` 上，新建独占临时图验证 100 项/一个修订、同 ID 重放、无关分支 token 保持、后代变化拒绝、部分成功及其重放，全部通过。临时图已删除。证据 `output/mcp-fix-production-smoke.json`。
- 当前 Codex 连接器使用的 8989 地址不可达；生产复核使用本地已有 MCP 凭据直连实际 8990 网关，没有更改客户端连接配置，也未验证 WB 客户端自身操作。

如需回滚，应同时恢复旧镜像和两个运行开关为 false，保留届时容器中的其他环境变量；仅换旧镜像不会恢复原来的写入模式。未删除生产备份或其他容器。
