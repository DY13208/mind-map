# 文件知识库

独立进程，不写入脑图节点，不修改现有 MCP。

```bash
cd knowledge-service
npm install
set KNOWLEDGE_DATABASE_URL=postgres://postgres:mindmap@127.0.0.1:15432/mind_map
set DOCLING_SERVE_URL=http://127.0.0.1:5001
npm start
```

- 页面：`http://127.0.0.1:3920`
- API：`http://127.0.0.1:3920/api/files`
- MCP：`http://127.0.0.1:3921/mcp`

也可以分开启动：`npm run api`、`npm run worker`、`npm run mcp`。停掉 MCP 进程不会停止 API，也不会停止脑图 MCP。

同一主机浏览器如果已经登录思维导图，知识库只读取 `auth_sessions` 识别用户，不刷新会话。也可以在页面里颁发 `klib_` 令牌：`POST /api/tokens`。

解析依赖外部 Docling Serve。Docling 没启动时，上传仍然成功，任务失败后按 5 秒、20 秒、60 秒重试，三次后标记 failed。这个失败只留在 `knowledge.jobs`。

回滚：

```bash
npm run rollback
```

这只会执行 `drop schema knowledge cascade`，并删除 `knowledge-service/data/objects`。

测试：`npm test`
