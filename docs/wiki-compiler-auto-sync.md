# 独立脑图编译库

wiki-compiler 直接读取脑图数据库和附件解析结果。编辑提交后防抖 2 秒自动更新，启动时核对全部有效房间，此后每 300 秒检查遗漏与失败。它不读取 Docmost 页面，不使用 Wiki 令牌或映射表，也不调用模型。

## 配置与启动

- `WIKI_COMPILER_SYNC_ENABLED`：默认 `true`，关闭后暂停编译，已发布内容仍按实时权限读取。
- `WIKI_COMPILER_SYNC_INTERVAL`：默认 `300` 秒。
- `WIKI_COMPILER_OUTPUT_DIR`：宿主默认 `data/wiki-compiler/wiki`，容器内 `/app/wiki-compiler`。
- `WIKI_COMPILE_DIR`：Docker 宿主挂载目录，默认 `./data/wiki-compiler/wiki`。
- `WIKI_COMPILER_CONTRACTS_DIR`：宿主默认 `data/contracts`，容器内 `/app/contracts`。
- `WIKI_COMPILER_COMPANY_ROOM_ID`：公司模型房间 ID；不配置时，仅在唯一有效、结构完整的「公司模型」脑图存在时自动绑定。绑定记录持久保存，改名不丢失；删除该房间后不会把合同 JSON 自动转交其他房间。
- `WIKI_COMPILER_INTERNAL_SECRET`：独立服务身份密钥，由启动脚本生成；与 Docmost 密钥无关。
- `KNOWLEDGE_DOCMOST_TOOLS_ENABLED=false`：从 Knowledge MCP 隐藏旧 Wiki/Docmost 工具；四个 `wiki_compiler_*` 工具仍可使用。

现有 `scripts/docker-up.js` 启动流程会生成并注入独立密钥。完全不部署 Docmost 时运行：

```powershell
node scripts/wiki-compiler-up.js
```

该入口只启用基础 Compose 的 postgres、redis、app、wiki-graph、knowledge-mcp，并关闭旧知识编译与 Wiki 同步；不会读取 `.secrets/wiki.env`，不会加载 Wiki 扩展 Compose。基础 `.env` 仍需存在。

直接使用 Docker Compose 时先生成独立密钥，并同时传入项目配置和独立密钥：

```powershell
node scripts/wiki-compiler-env.js
# Fresh checkout only: prepare the runtime-config file mount.
Copy-Item docker/runtime-config.js docker/runtime-config.local.js
docker compose --env-file .env --env-file .secrets/wiki-compiler.env -f docker-compose.yml up -d --build postgres redis wiki-graph knowledge-mcp app
```

不要输出或提交 `.secrets/wiki-compiler.env`。Knowledge MCP 的认证仍使用脑图账号签发的个人令牌，密钥生成保留已有 `KNOWLEDGE_MCP_JWT_SECRET`，不会主动替换现有令牌密钥。

手动核对所有脑图（无需 Wiki）：

```powershell
node scripts/wiki-compile-model.js --wiki-dir data/wiki-compiler/wiki
node scripts/wiki-compile-model.js --wiki-dir data/wiki-compiler/wiki --dry-run
```

预演只列出待检查房间，不初始化数据库或写入输出文件。

## 发布与权限

每房间的 `rooms/<roomId>/current.json` 指向完整、不可变的 `generations/<generation>/bundle.json`。主题 slug 根据房间 ID 与节点 UID 生成，同名主题不覆盖，改名不改变标识。旧版本保留供恢复。`[WikiCompiler]` 日志记录核对房间数、源版本、发布版本和失败原因。

图谱、搜索和正文请求经应用认证；内部数据接口验证 30 秒服务身份凭证并实时查询脑图读取权限。未授权主题返回 404，权限查询故障返回不可用；搜索先过滤权限再排名。MCP 与 CPD 检查使用同一授权链路，个人脑图不会进入全员共享视图。当前图谱提供根概览到一级主题的结构关系，不推断跨图关联。

合同分类、模板字段与已有合同从公司模型节点树读取，JSON 补充内容绑定该房间权限。首次发现旧 `INDEX.md`、`.compile-state.json`、主题及概念目录时，先备份到 `.legacy-backups`。旧产物没有脑图来源权限，不通过新数据接口公开。

共享的 `knowledge/compiler`、`snapshot`、`markdownRenderer`、`manifestStore`、`sourceChanges` 是脑图快照和附件基础模块，需要保留；新链路不导入包含 Docmost 的 `knowledge/index`。测试 Wiki 服务和适配器可独立删除。

## 验证

```powershell
node --test simple-mind-map/bin/wikiCompiler/*.test.js integrations/wiki-graph/*.test.cjs
node --test simple-mind-map/test/cpd*.test.js integrations/knowledge-mcp/tests/*.test.js
```

PostgreSQL 集成测试通过 `WIKI_COMPILER_TEST_ENV_FILE` 读取连接配置，默认宿主端口 15432；测试创建随机独立 schema，并在结束时清理，不修改业务房间。MCP 独立性测试模拟旧 Wiki/Docmost 适配器被删除。
