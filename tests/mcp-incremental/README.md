# MCP 增量写入阶段一基线

此目录只用于在独立环境重现 `0160b5a774984158829427a7733ac2b7c588e697` 的写入和协同基线。Compose project 固定为 `mcp-incremental-test`，使用独立 PostgreSQL/Redis、命名卷、端口和本地测试凭证。应用镜像由当前 worktree 的 `Dockerfile` 完整构建，前端也在镜像构建中重新编译；容器不读取项目根 `.env`，不挂载生产数据。

PowerShell 中从仓库根运行：

```powershell
$env:MCP_BASELINE_RUN_ID = "baseline-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Force tests/mcp-incremental/results | Out-Null
docker compose --env-file tests/mcp-incremental/test.env -p mcp-incremental-test -f docker/mcp-incremental-test.compose.yml up -d --build postgres redis app-a app-b
npm --prefix tests/mcp-incremental run smoke
npm --prefix tests/mcp-incremental run phase1
docker compose --env-file tests/mcp-incremental/test.env -p mcp-incremental-test -f docker/mcp-incremental-test.compose.yml stop app-a app-b redis postgres
```

`stop` 会触发测试 Node preload 将缓冲计量写入 `results/<run-id>-app-a.jsonl` 和 `results/<run-id>-app-b.jsonl`；它不会删除测试卷。需要完全重置时，只能针对该测试 project 执行 `docker compose ... down --volumes`。不要省略 project 名，也不要对其他 Compose project 执行清理命令。

基准会建立 6001 节点房间（1 根、20 个分支、每分支 299 个叶节点），每轮使用新房间并顺序调用 MCP `add_node` 100 次，共 10 轮。页面验证使用 13 个独立 Chromium contexts，分别连到两个 app 实例；展开/收起通过真实 DOM 按钮操作。PG client preload 记录事务与 `FOR UPDATE` SQL 往返，PG server 开启 `log_lock_waits`；SQL 参数值不记录。缓存计量来自只在 Node 内存中的测试 observer 包装 `applyCommittedLive`。

报告必须区分 MCP meta/read、HTTP write、PG transaction、`FOR UPDATE` 往返、PostgreSQL 可见锁等待、提交后 live/cache observer、客户端远端可见和浏览器指标。PG 观测不到的锁等待或缓存子阶段必须标为未测，不得用写请求总时长替代。
