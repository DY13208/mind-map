# 性能与 MCP 分页修复

## 改动与兼容性

- 事件桥按房间、版本和操作 ID 跳过重复唤醒，读取失败可重试，周期性 head 对账仍保留。去重记录最多 2048 条；饱和时正常调度但旁路去重，不丢通知。新增 `skippedDuplicateWakeups`、`emptyDrains`、`duplicateRatio` 汇总。
- 子树的真实直属子节点数和全部后代数按数据库实例、房间版本缓存；只在自建 PostgreSQL Repeatable Read 只读快照中共用缓存。客户端/外部事务旁路，避免回滚污染。最多 16 个房间、10 万条节点计数；同版本请求 single-flight，缓存满时正常计算。分页 total 使用权威计数，避免额外 COUNT 查询。
- 水合请求检查 UID 生命周期与房间身份：删除、恢复都使原请求失效；等待连接槽位的过期请求不发送 HTTP；已经发送的旧响应不应用。恢复后的读取不复用失效的请求。
- 浏览器验收发现基线已有的移动撤销问题：服务端撤销成功后，内部将空的 `isFloating` 归一化为 `false` 并产生普通更新，清空重做栈。修复只消除这类语义空操作，保留用户从 `true` 改为 `false` 的实际更新；发布仍需真实工具栏撤销、重做通过。
- MCP `list_maps` 默认 20、最大 100 条，支持 `query` 和 `cursor`，保留列表/总数/房间字段，增加 `has_more`、`next_cursor`。权限过滤在服务端分页前完成。损坏游标明确返回 `INVALID_CURSOR`。
- 原有查询、搜索、概览、导出及导出文件读取职责不变。本分支原始验收时 MCP 尚无 `get_performance_diagnostics`；合并到 main 后保留 main 已有的只读诊断工具，本次分页修复不修改其权限和行为。
- 没有新增或修改数据库字段，无本次迁移脚本。已有归档操作幂等索引在发布前检查。Compose 显式保留事件桥与 MCP Direct 的关闭默认值，避免升级代码时自动切换协议。

## 验证入口

需要当前项目依赖；验收脚本固定隔离 PostgreSQL `127.0.0.1:25492/mcp_incremental_test`、Redis `127.0.0.1:16389`，不会读取生产凭证或向业务房间写入夹具。

```powershell
node simple-mind-map/test/mcpEventBridge.test.js
node simple-mind-map/test/mcpEventBridge.twoInstance.integration.test.js
node simple-mind-map/test/subtreeCountCache.test.js
node simple-mind-map/test/roomSubtreeCounts.test.js
node simple-mind-map/test/roomSubtreeCounts.pg.test.js
node simple-mind-map/test/collabHydrationDeletion.test.js
node simple-mind-map/test/collabHydrationUndo.test.js
node simple-mind-map/scripts/fieldMergeFloatingSemantics.unit.cjs
node simple-mind-map/test/collabNodeFeatures.test.js
node web/tests/fileApi.subtreeLifecycle.test.cjs
node scripts/test-mcp-list-maps.cjs
node scripts/deploy-performance-repair.unit.cjs
```

性能验收分别保留直接数据库读取和实际 HTTP 样本，不把函数耗时当作浏览器交互时间。基线固定为修复前 `8c9c3d16`，数据规模 100/6000 节点，每组 120 次读取。HTTP 脚本不带 `--run` 时只打印配置；`--linux` 使用生产同版本 Node 20 镜像和现存隔离网络中的数据库、Redis，源码和诊断依赖只读挂载，测试容器仅本次创建并清理。

```powershell
node scripts/performance-repair-benchmark.cjs 8c9c3d16
node scripts/performance-repair-http.cjs --linux --run
node scripts/performance-repair-browser.cjs --run
node scripts/performance-repair-browser-large.cjs --run
```

双浏览器脚本支持 `PERFORMANCE_REPAIR_BUILD_DIR` 指定静态资源目录；最终撤销/重做验收使用成品 Docker 镜像提取的 `output/performance-repair-20261013/build-image-final/`，以验证实际待部署资源。最终 Docker 构建成功；Windows 的最后一次独立前端构建未产生完整产物，其日志保留，不计为构建通过。

原始结果、失败运行、截图和构建保存于 `output/performance-repair-20261013/`，不提交这些产物。Windows HTTP 测量出现较高基线波动和事件循环 gate 失败，其结果保留为限制证据，不能冒充通过。

Linux Node 20.20.2 的单轮同负载对照：

| 规模 | HTTP P95 修复前→后 | 事件循环 P95 修复前→后 |
| --- | --- | --- |
| 100 节点 | 31.15→30.91 ms | 10.88→10.88 ms |
| 6000 节点 | 40.01→37.44 ms | 15.52→10.96 ms |

每来源/规模 120/120 请求成功；HTTP 和事件循环均未退化超过 10%，本轮 gate 通过。跨轮稳定性尚未评估，不用单轮结果声称生产性能保证。直接 PostgreSQL 读取回归另验证同版本 120 次读取仅扫描一次完整关系，6000 节点函数 P95 约 23.97→7.59 ms；这是函数级指标，不能与 HTTP 延迟混用。

6000 节点真实浏览器夹具已验证：首屏只渲染 8 个主节点；分支 n1 的权威直属子节点数/后代数均为 749，通过 3 次成功分页请求加载完毕。收起后计数保留，再次展开增加的子树请求为 0，浏览器错误为 0。测试房间及关联数据已精确清理并确认无残留。结果和截图见 `output/performance-repair-20261013/browser-large/2026-10-13T10-41-49-217Z-0bddd316/`。

最终成品前端双窗口验收通过：新增、移动、真实工具栏撤销/重做、MCP 写入双端可见、断线重连及重连后 MCP 写入均正常，浏览器错误为 0。报告见 `output/performance-repair-20261013/browser/2026-10-13T10-45-04-112Z-66ff1359/summary.json`，静态资源集合 SHA-256 为 `0aa32dd604a1d10c89f5cb93cec4682735f4029bba778da18209f3e57ab76372`。早期失败记录保留；隔离验收未配置 COS，删除 API 报缺少 Bucket，脚本只清理本轮精确房间并核验数据库残留为 0。

## 发布与回滚

仅在自动化回归、HTTP 性能 gate 与双浏览器功能验证通过后发布。发布前读取实际部署的环境、镜像 ID、功能开关、数据库结构和容器可写层。发布使用固定标签，保留环境、端口、挂载与网络；不启动其他项目或修改业务房间。

```powershell
node scripts/deploy-performance-repair.cjs --inspect
node scripts/deploy-performance-repair.cjs --dry-run --deploy mind-map-app:perf-repair-<提交号>
node scripts/deploy-performance-repair.cjs --deploy mind-map-app:perf-repair-<提交号>
```

回滚容器保持停止，禁用 Compose 管理身份、端口绑定、生产网络及自动重启；旧镜像和原环境配置留在本地 Docker，凭证不写入发布报告或镜像。Docker 会继承镜像标签，备份因此把 Compose 标签值显式置空，避免仍被匹配成正式服务；校验区分空键与有效管理标签。若旧代码目录有可写层补丁，脚本停止，避免使用不包含补丁的旧镜像作为备份。健康失败或镜像不一致时恢复原服务。成功后的 `deployment.json` 提供确切的回滚命令；回滚会重建带正确 Compose 身份的应用，而不是启动孤立备份。

发布后核对健康、功能开关、运行文件哈希和数据库列结构；最终手动验收仍由用户确认，重点是在实际业务大图展开/收起及两个窗口间编辑同步。
