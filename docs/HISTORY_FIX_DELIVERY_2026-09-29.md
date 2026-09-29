# 历史预览与编辑者归因修复交付

## 原因与修复范围

1. 历史撤销引用检查点之前的操作时，会回查活动表和归档表。原查询使用 `SELECT * UNION ALL`，两表列数和列含义不同，导致 PostgreSQL 拒绝查询。改为两处查询共用显式字段清单，保留跨表回查。
2. 打开历史面板会补齐自动版本，旧逻辑把请求者作为编辑者。普通自动、手动版本现从同一区间原始操作的 `actor_id` 计算编辑者和摘要；创建者字段继续表示创建版本记录的人。
3. 旧版本在列表与详情响应时校正编辑者，不更新已有历史记录。固定区间优先；旧记录使用完整时间线判定前驱，遇到隐藏版本、缺失边界或操作缺口时返回空编辑者。

自动版本补齐保留即时体验。任务处理与面板补齐在现有房间锁事务中检查修订、生成元数据、创建版本和完成任务；重复自动版本利用现有唯一索引返回原记录，不重复审计。锁内不执行历史树回放。

## 接口兼容与数据

- 路径、`createdBy`、即时补齐行为保持兼容。
- `editors` 表示真实操作者；不把版本创建者或查看者补入。
- `summary.fromRevision`、`summary.toRevision` 是可选字段，统计区间为 `(fromRevision, toRevision]`。
- 自动版本编辑者无法确认时显示“编辑者未记录”。初始化、导入、恢复等专用版本保留原语义。
- 没有新增数据库字段、迁移脚本、服务或线上回填。本地根目录配置已切换为本机 PostgreSQL。
- 回放错误保留内部原因，日志仅记录房间、修订、操作和目标 ID、底层错误码，不记录节点正文。

## 验证

写入测试使用独立临时 PostgreSQL 库。入口在加载 harness/storage 之前检查环境，要求 `MIND_MAP_SKIP_ROOT_ENV=1`，拒绝非回环地址、业务库 `mind_map` 和缺失配置。

| 验证 | 结果 |
| --- | --- |
| `npm run test:collab:history` | 通过；历史单测、协同撤销、水合与 HTTP 历史刷新，新增归因、固定区间、只读旧记录和任务边界用例 |
| `npm run test:collab:history:pg` | 通过；跨检查点撤销/重做、活动与归档目标、缺失目标、重复 AUTO 插入事务、批量归因、真实 PG 多实例并发和继续编辑 |
| `npm run test:collab:v2` | 完整协同回归通过，包含粘贴撤销、恢复、可靠性和节点测试 |
| 协同撤销、水合与 HTTP 历史刷新 | 28 项通过 |
| `node simple-mind-map/test/mcpHistory.test.js` | 通过 |
| `node simple-mind-map/test/collabHistory.perf.test.js` | 通过；一万节点历史列表 P95 约 48ms、树读取 P95 约 228ms（本机内存测试，不代表线上性能） |
| `node web/tests/historyAttribution.component.test.cjs` | 通过；真实组件方法验证空归因、单人/多人、手动和导入语义 |
| `historyOverview.test.cjs`、`productShell.services.test.cjs` | 通过 |
| Vue CLI 生产构建 | 通过；已有体积警告和 Browserslist 数据过旧提示 |

语法检查与 `git diff --check` 通过；`codegraph sync` 和 `codegraph status` 完成，索引正常。测试日志保存在 `output/history-fix-*.log`。

生产前端输出位于 `output/history-fix-build`，没有覆盖现有 `dist` 或部署线上。构建使用 `NODE_OPTIONS=--openssl-legacy-provider --max-old-space-size=4096`，解决当前 Node 24 与项目 Webpack 4 的 OpenSSL 兼容问题，没有改变项目配置。

两项验证限制：

- `productShell.realApi.test.cjs:498` 的既有断言禁止路由重定向到 `/files`，而 HEAD 已包含该路由，本次没有修改路由。该测试仍失败。
- `historyPreview.browser.test.cjs` 依赖 `simple-mind-map/node_modules/@playwright/test`，当前宿主缺少该依赖，无法运行；没有把未运行的浏览器测试报告为通过。

## 发布验收与回滚

发布应使用同时验证的后端与前端构建，不执行历史数据更新脚本。上线后检查：

- 问题脑图 18:06 至 18:19 的版本可预览；能够可靠判定区间的三条旧错归因记录显示陈华俊。
- 重复打开面板不生成同修订的重复自动版本；没有编辑的查看者不进入 `editors`。
- 后续编辑只计入后续版本；手动版本创建者仍正确显示。

本次没有发布，以上线上验收尚待发布后执行。发生回归时回滚应用后端和前端构建，保留原始检查点、版本和操作记录；不执行数据库回滚或清理脚本。

## 同步主分支后的提交验证

- `codex/hx-dev` 通过 `git merge --no-edit origin/main` 快进合入主分支 `8576c045`，本地已有改动恢复成功，没有冲突。
- 提交仅包含本次历史修复的源码、测试和交付说明，共 16 个文件；工具栏检查按钮、CPD API、迁移、组件及相关测试均未纳入。
- 使用主分支加本次提交内容的干净临时工作树再次验证：完整历史测试、隔离 PostgreSQL 集成与多实例并发、前端归因组件、历史概览及生产构建均通过。
- 干净构建产物在 `output/history-submit-clean-build`，不包含未提交的检查按钮功能；测试日志在 `output/history-submit-clean-pg.log`，构建日志在 `output/history-submit-clean-build.log`。
- 同步后已执行 CodeGraph sync/status。文件索引显示最新，同时存在后台待解析引用提示；未改动另一任务的 `codegraph.json` 配置。
