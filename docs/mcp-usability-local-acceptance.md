# MCP 易用性与批量可用性验收记录

## 本轮范围

- 优化 MCP 参数说明、`query_nodes` 写入提示、批量错误原因透传与相关文档。
- 在隔离本地实例验证 Direct、事件桥和房间节点表的批量前置条件及批量写入语义。
- 分别检查新对话与刷新后的已有 Agent 能否正确使用工具。
- 本轮不发布远端服务、不改变远端开关、不重启远端实例。

## 当前执行状态

状态：代码实现和原 9 组自动化/本地 HTTP-MCP 协议检查通过。2026-10-26 后续 Docker 已恢复，按用户要求合并 main 并重建现有本地实例，合并后 11 项回归通过；事件桥健康与 Direct 开关、新工具定义已验证。隔离批量数据库写入、浏览器协作和真实 Agent 人工验收仍未完成，不能宣布整个计划已验收完成。

实现基线为 `codex/hx-dev`，HEAD `8cb5e9f43e3d1fab4e4e7348fe336efca3fa0019`；开始时已跟踪文件无修改，原有未跟踪产物保留。当前改动未提交、未推送。此前 Docker 阻断为历史状态；后续按用户要求重建本地 app，未改用远端业务房间或生产数据库补测。

### 已完成的只读预检

2026-10-26 执行 `node simple-mind-map/scripts/mcp-writer-http.cjs --dry-run`。预检因 Docker Engine 不可达而终止，退出码 1，未开始任何运行检查，未创建容器、数据库或 Redis 资源，清理项均为空。

具体错误：`failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`。因此，本机隔离批量运行验收当前受 Docker daemon 阻断；此预检不代表代码测试失败或通过。

原始证据：[mcp-writer-http-dry-run.txt](../output/mcp-usability-20261026/mcp-writer-http-dry-run.txt)。

## 自动化与协议检查

| 检查项 | 命令/证据 | 结果 |
| --- | --- | --- |
| 写入条件提示、HTTP 到 MCP 错误透传 | `node simple-mind-map/test/mcpUsability.test.js` | 通过，21 项检查 |
| 查询默认结构、条件提示、分页与分片 | `node simple-mind-map/test/nodeQuery.test.js` | 通过，含 fake DB 查询分支；不等同真实 PG |
| 字段并发前置条件 | `node scripts/mcp-write-guards.unit.cjs` | 通过，12 项检查 |
| 前端受保护错误终态 | `node scripts/mcp-guard-terminal.unit.cjs` | 通过 |
| Direct 请求形状 | `node scripts/mcp-direct-policy.unit.cjs` | 通过 |
| Direct 入口及兼容边界 | `node scripts/mcp-direct-entry.unit.cjs` | 通过 |
| 历史/写入兼容 | `node simple-mind-map/test/mcpHistory.test.js` | 通过 |
| 批量 HTTP 安全错误详情序列化 | `node scripts/mcp-batch-error.unit.cjs` | 通过，5 项检查 |
| MCP 终态回执逻辑 | `node simple-mind-map/scripts/mcp-terminal-receipt.unit.cjs` | 通过；非真实数据库验收 |
| PostgreSQL 查询及批量回执 | 对应隔离 PG 测试 | 阻断，未运行 |
| 补丁格式与 CodeGraph | `git diff --check`; `codegraph sync`; `codegraph status` | 通过；索引状态为 up to date |

9 组自动化检查的退出码、耗时和逐组日志见 [automated-summary.json](../output/mcp-usability-20261026/automated-summary.json)。新增协议测试启动了本地临时 MCP 子进程和内存 HTTP 后端，使用实际业务校验函数和实际错误序列化函数；它没有启动生产 API、PostgreSQL、Redis、事件桥或浏览器，也不能证明服务端落库、事件传播和真实终态回执幂等已经验收。测试后临时监听及子进程已关闭。

`mcp-writer-http.cjs` 已尝试只读预检，但在 Docker 镜像检查步骤阻断。Docker 恢复后，先构建本次工作区镜像并通过进程级 `MCP_WRITER_IMAGE` 指定它，再重新运行 `--dry-run` 和 `--run --focused`；使用脚本专属临时容器、数据库与房间。不得复用默认历史镜像作为本次代码验收。聚焦脚本已补默认查询无提示、三组提示及提示用于更新的断言，语法检查通过，运行结果仍待环境恢复后取得。源码快照复制并校验整个 `bin` 目录，新提示模块会随之进入实际测试实例。

## 隔离运行验收

分阶段记录每一步的环境开关、健康状态及命令回执：

1. 事件桥与 Direct 关闭：单项兼容行为正常；批量明确拒绝并返回真实原因。
2. 事件桥开启、Direct 关闭：监听健康、事件传播、补偿及恢复通过。
3. 事件桥健康、Direct 开启、房间节点表就绪：合法 `apply_nodes` 显示 Direct 路径。
4. 使用隔离测试房间验证新增、更新、部分成功、依赖失败、全部失败、版本递增和原 ID 重放。
5. 使用两个调用会话验证字段冲突仍被拒绝，断线恢复后读取结果与服务端一致。
6. 未就绪或请求形状不支持时，错误码、HTTP 状态和 `details.fallbackReason` 与实际原因一致，且无业务写入。

| 步骤 | 实际实例/镜像 | 结果与证据位置 | 状态 |
| --- | --- | --- | --- |
| 事件桥关闭的真实拒绝路径 | 未启动 | Docker Engine 不可达 | 阻断 |
| 事件桥传播与恢复 | 未启动 | Docker Engine 不可达 | 阻断 |
| Direct 批量成功路径 | 未启动 | Docker Engine 不可达 | 阻断 |
| 并发、幂等及部分失败 | 未启动 | Docker Engine 不可达 | 阻断 |

## Agent 理解验收

真实 Agent 调用须分别记录，不能用固定请求脚本代替：

- 新对话仅依靠工具定义查询并正确构造扁平 `expected`。
- 刷新 MCP 定义的既有对话仍能使用原扁平结构。
- 未传 `include_write_hints` 的旧客户端保持兼容；开启后 Agent 能复用对应的 `write_hints.update` 条件。
- Agent 能区分参数缺失、版本冲突和 Direct 不可用，不把外层 HTTP 200 或 `writeSubmitted=true` 当成业务成功。
- 批量条件缺失时 Agent 停止并报告，不通过循环调用单项工具模拟批量。

| 客户端场景 | 客户端/模型版本 | 观察记录 | 状态 |
| --- | --- | --- | --- |
| 全新对话 | 待填写 | 待填写 | 待人工验收 |
| 刷新后的旧对话 | 待填写 | 待填写 | 待人工验收 |
| 旧请求兼容 | 待填写 | 待填写 | 待人工验收 |

工具定义更新通常通过断开并重连 MCP 刷新。仍缓存旧定义时，再重启客户端或新建对话。该客户端步骤不会改变服务端开关。

## 数据库、远端与限制

- 本次不新增数据库结构。隔离数据库的 `009_mcp_archive_operation_id_index`、`012_mcp_terminal_receipts` 和上游迁移实际准备情况尚未核验，原因是隔离数据库未启动；环境恢复后核验并记录索引及表状态，不能把仓库存在迁移文件当作数据库已经应用。
- 远端健康读取只作为对应时间的运行状态证据，单独记录实例地址、观察时间和 health 字段，不能代表本次代码已部署。
- 2026-10-26 14:34:16（北京时间）只读访问 `https://xx.stillgroup.net:8989/api/health`：HTTP 200，`collabV2=true`、`eventBridge.enabled=false`、`listenerHealthy=false`、Redis bus `ok=true`；整体 `ok=false` 且有 `version_gap` 告警。未把这些告警推断为本轮新增代码问题。已知事件桥关闭仍阻断批量，Direct 实际开关、房间表状态和部署提交未获验证。精简证据见 [remote-health-readonly.json](../output/mcp-usability-20261026/remote-health-readonly.json)，未写远端业务数据。
- 远端发布、迁移、重启及事件桥或 Direct 开关变更均不属于本轮执行。发布前按 `docs/mcp-incremental-release.md` 核验数据库准备，先启用并验证事件桥，再启用 Direct，最后在隔离远端房间验收。
- 回退优先关闭 Direct 并保留事件桥和兼容能力。不得在回退中删除幂等索引、终态回执或业务数据。

### 远端后续操作单（本轮未执行）

1. 核对实际部署提交、实例数量及每个写入实例的生效配置，不以 MCP `1.4.0` 标签代替 Git 版本。
2. 查明事件桥关闭原因，核对 Redis/总线连接、既有迁移的表和有效索引；不在普通请求中补 DDL。
3. 发布兼容代码后先验证批量拒绝回执的 `details.fallbackReason` 贯穿 HTTP 与 MCP，保留原 code/status/outcome。
4. 先启用事件桥，检查监听健康、事件传播、补偿和重连恢复；再开启 Direct。两者是实例级配置，不是测试房间级开关。
5. 使用独立远端测试房间，验证批量新增、文字/备注/链接修改、部分失败、依赖失败、全部失败和同 ID 重放。
6. 检查实际 `submissionPath=direct`、逐项业务结果及版本：有成功项只推进一次，全部失败和同 ID 重放不再推进。
7. 用两个会话核验冲突保护、可见内容和恢复；客户端刷新工具定义后再验新旧 Agent，不把外层 HTTP 200 当成功。
8. 若出现问题优先关闭 Direct，保留事件桥及兼容读取；必要软件回退必须兼容回执和历史格式，不能删除表、索引、终态回执或业务数据。

## 验收结论

代码与可运行的自动化检查已经完成；本次无数据库字段/表/迁移新增，无远端部署或开关变更。隔离运行、真实客户端 Agent 理解及用户人工验收未完成，整个计划保持部分完成状态。未运行、受环境阻断和 TODO 项均不记为通过；Docker 恢复后按上表续验，远端发布另行安排。

## 2026-10-26 后续：合并主分支并提供本地手测实例

- 用户要求改连本地 MCP 手动测试。主分支通过 `git merge --no-edit --autostash origin/main` 从 `8cb5e9f4` 快进至 `0d592dc7`；本轮修改恢复，无冲突。已备份到 `output/mcp-local-rebuild-20261026/premerge-1792997103150/`。
- 合并后 11 项回归全部通过，构建镜像 `mind-map-app:mcp-usability-local-20261026-0d592dc7`，只重建 `mind-map-app-1`。原端口 8990 和原有数据卷保留。
- 本地数据库以只读 SQL 核验 009 的归档操作 ID 索引有效、010 的计数缓存结构及触发器、011 的角色字段、012 的终态回执表；未发现需补迁移，无新数据库结构或迁移执行。
- 使用仅本地覆盖文件分两步启动：先 bridge=true / Direct=false 验证监听，再 bridge=true / Direct=true。最终 `/api/health` 为 ok=true，事件桥监听健康；初始化和 tools/list 通过，include_write_hints 和新 expected 说明可见。核心 4 个运行源码文件 SHA-256 与工作区一致。
- 本地网页 `http://localhost:8990/`；MCP `http://localhost:8990/mcp`。从本地 MCP 接入页领取个人配置并刷新连接；不将远端旧会话视为本地已验证。
- 启动覆盖文件 `output/mcp-local-rebuild-20261026/local-mcp.json`；重新启动 app 时继续带该文件，否则基础 Compose 默认关闭的开关会重新生效。
- 证据：`output/mcp-local-rebuild-20261026/local-verification.json`、`postmerge-tests/summary.json`、`app-build.log`。用户业务写入与真实 Agent 理解验收待手工完成；未修改任何远端开关、服务或业务节点。

## 用户反馈与提交前状态

用户随后提供 WorkBuddy 本地单 Agent 验收报告：工具定义刷新、默认查询兼容、写入提示、文字/备注/超链接修改、批量新增和修改、同 ID 幂等重放、旧条件冲突、部分成功及全部失败均按预期完成。测试图为 `room-o1c66g99`，报告中的房间版本最终为 9；这是用户提供的验收证据，不是本报告重新执行所得。

报告同时指出单项预期失败只展示文本，尚需检查原始 MCP JSON，不能仅凭客户端展示判断结构化字段缺失。双客户端实时协作、断线恢复及完整并发场景也仍待验收；不将本地单 Agent 功能通过扩大成整个计划已完成。

提交前再次获取主分支，以 `git merge --no-edit --autostash origin/main` 快进至 `96a9bfe9`，本轮修改恢复且无冲突。本轮 MCP 优化不新增数据库结构；这次主分支更新另外包含文件知识库的 `010_direct_links.sql`，新增 `kb.direct_links` 表，后续部署文件库服务时须按其既有迁移机制准备。本次提交操作不执行迁移、不重建容器、不发布远端；当前本地容器仍为此前 `0d592dc7` 加本轮工作区改动构建的已验收镜像。

测试日志和本地 Compose 覆盖文件保存在被忽略的 `output/` 目录，不随本次代码提交上传。`.env` 和本地个人凭证不在提交范围内。

`96a9bfe9` 上提交前复验：9 组 MCP 相关测试和节点提及、同级插入两项测试全部通过，新增前端直链测试也通过。新增文件库后端直链测试因本机缺少其声明的 `busboy` 依赖而未能加载，未记为通过；本机也没有可用于补测的运行中文件库容器。未修改依赖清单或部署服务。证据目录为 `output/mcp-submit-20261026/tests/`。
