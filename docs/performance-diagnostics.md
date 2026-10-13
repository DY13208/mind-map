# 多人协作与 MCP 卡顿诊断

此接口用于部署后采集证据，不代表已经确认或修复生产卡顿。保留接口，后续可重复比较。

## 当前代码审计结果

- MCP 写入经 `bin/mcpServer.mjs` 的 `writeMap` / `writeNodeMap` 调用 HTTP。V2 的 `format=meta` 已有轻量路径，不应再把所有 MCP 修订号查询描述为整图读取。
- `bin/mindApi.js` 的 `executeMcpDirectOperation` 已支持直接节点写入。只有满足 `COLLAB_MCP_DIRECT`、V2、事件桥、房间初始化和操作形状等条件才进入该路径，其他受支持操作仍可能进入旧整图路径。诊断的 `transaction.path=direct/full` 记录实际执行路径。
- `bin/storage.js` 两种写入都使用房间行 `FOR UPDATE`。同房间写入可以相互等待；人数和锁竞争不是同一个指标。
- `src/plugins/Cooperate.js` 中，远端插入到展开的分支会请求渲染；折叠分支使用计数/脏标记。远端更新、移动和补齐操作也有渲染路径。持续多人操作或 MCP 高频写入可能让接收方频繁布局，需结合 `remote`、`render`、`longtask` 验证。
- `web/src/utils/fileApi.js` 的 API 并发上限是 2。请求在浏览器队列里的等待不会出现在服务端日志里，新增 `api-queue` 专门记录它。
- 非根子树计数只读取该子树的 UID/parent 边；根节点展开仍读取全房间边，因为根的后代数覆盖整张图。`/locate` 在 `room_nodes` 能证明祖先链时只读取祖先节点和 UID/parent 边，不再读取完整节点快照；文字查找和断链仍回退到快照。根节点计数和祖先的后代数仍可能扫描大量边，生产影响待验证。
- presence 已有房间广播合并，不能仅凭“6 人在线”断言广播导致卡顿。查看实际操作频率、可见节点数、长任务和等待数据。

以上是静态代码证据；MCP、锁竞争、浏览器渲染各自对生产卡顿的贡献仍待验证。

## 部署与开关

用完整的 `Start-Docker.bat` 更新服务，包含前端和后端。Compose 默认注入 `PERFORMANCE_DIAGNOSTICS=1`，不需要新增密钥。

读接口使用现有的超级管理员权限 `MIND_MAP_SUPER_ADMIN_IDS`。如尚未配置，将真实的内部用户 ID 或企微 userid 加入该变量；不要设置为所有用户。普通用户只能上报自己有查看权限的房间，不能读取诊断；共享 MCP service token 不能读取诊断。

可在 `.env` 设置 `PERFORMANCE_DIAGNOSTICS=0` 并重建容器关闭采样和接口。独立运行 Node 时需要显式设为 `1`。

## 开启浏览器采样

在参与验证的页面地址后加 `&perfDiagnostics=1`（若没有其他参数则用 `?perfDiagnostics=1`）。例如：

```text
https://你的生产域名:8989/?room=room-xgoibqb8&perfDiagnostics=1
```

每个参与验证的浏览器单独开启。重新打开页面后正常操作，无需开 DevTools。每 10 秒上报一次，每批最多 100 条；退出编辑器停止采样。服务返回 401/403/404 后停止上报，修复配置后刷新页面重新启用。移除该参数并刷新即可停止本页采样。

采样包括渲染耗时/引擎报告的渲染节点数、Long Tasks、API Resource Timing、API 队列等待、本地提交到成功/失败 ACK 的等待、远端应用事件、Outbox 数量和补齐/重连计数。`canvas-ready` 是编辑器诊断初始化到真实首屏就绪的时间，不是完整导航耗时。浏览器不支持 Long Tasks 时该项缺失，不能视为没有卡顿。

## 读取数据

超级管理员在已登录的同一浏览器打开：

```text
/api/diagnostics/performance?room=room-xgoibqb8
```

完整地址是生产页面的协议、域名和端口加上述路径。JSON 可直接另存为文件。403 表示当前用户不是已配置的超级管理员；404/`DIAGNOSTICS_DISABLED` 表示后端未开启或未更新。

MCP 新增只读工具 `get_performance_diagnostics`。部署后刷新 MCP 工具列表，使用超级管理员的个人 MCP 授权即可读取：

```json
{"room_key":"room-xgoibqb8"}
```

后续调用传上次的 `cursor` 为 `after`，只返回新的事件；`summary` 始终是当前窗口汇总。也可传 `since`（Unix 毫秒）过滤本轮对比数据。进程重启后 `processId`/uptime/cursor 会改变，应清除旧 cursor。房间号未知时可不填，读取当前进程所有房间；不能自行替用户选择业务房间做写入测试。

## 对比步骤

1. 同一张图、同一批展开节点，先保持 MCP 暂停写入，1 人正常操作约 2 分钟，记录开始时间并保存 JSON。
2. 保持 MCP 暂停写入，增加到实际的 6 人；先只浏览，再正常编辑，分别采样约 2 分钟。
3. 保持人员和可见分支一致，让 MCP 连接但空闲，采样约 2 分钟。
4. 在用户本来就要执行的业务写入期间采样 MCP 活跃场景。额外压测/批量造节点必须使用隔离测试房间，不在生产业务图里制造测试写入。
5. 每轮使用新的 `since` 分别保存结果，至少等待一次 10 秒上报后再下载。记录 MCP 在做什么、房间节点总量、可见节点数、人数和开始结束时间。

如何解释：

| 数据变化 | 支持的排查方向，仍需场景对比 |
| --- | --- |
| MCP 活跃时 `transaction` 的 `source=mcp,path=full` 多且慢 | MCP 落入整图事务路径；查具体操作形状和配置 |
| `pool` 慢、`runtime.pool.waiting` 高 | 数据库连接等待；查看后台编译/同步与操作负载 |
| `lock-query` 慢 | 锁查询这一阶段慢；不能直接宣称都是行锁等待 |
| `remote` 密集、`render` 频繁且 `longtask` 增多，服务器事务较快 | 接收端操作应用/布局/主线程开销 |
| `api-queue` 慢，服务器 HTTP 较快 | 浏览器并发队列等待 |
| HTTP/Resource Timing 都慢、事务或事件循环延迟升高 | 服务端或传输开销；继续拆分 |
| ACK 慢、Outbox 增长或补齐计数增长 | 提交排队、网络、重试或 Gap Sync；ACK 是端到端指标 |
| 只有 MCP 活跃时明显变差，暂停后恢复 | 支持 MCP 负载相关性；需用上面各层指标确定机制 |

## 数据边界

- 结构化性能样本，不是任意 Docker/文件日志读取接口。不会返回 `.env`、认证头、Cookie、Token、SQL 正文、节点标题或备注。
- 全进程最多 3000 条，读取最近 15 分钟；重启丢失。`overwritten` 是进程生命周期内被容量上限覆盖的条数；浏览器 `client-state/type=sampleDrops` 是本页队列丢样计数。采样缺失不能当作没有慢请求。
- `seq/at` 是服务端接收时间；浏览器数据最多约 10 秒后上传。时长使用单调时钟，不能拿上传时间当作浏览器事件发生时间。
- 路由只保存归一化分类；`format=meta` 单独标记为 `/api/files/:room/meta`，不会把它误当成整图读取证据。
- `lock-query` 是 `SELECT ... FOR UPDATE` 往返耗时，包含锁等待、查询、网络和行解码。整图路径的返回值更大，不能将该指标当作纯行锁等待。
- `transaction` 从取得连接到事务函数完成（失败时包括回滚），与 `pool` 分开；不包含之前的 MCP 提交限流排队。每次重试记录独立样本，不能把样本数当作唯一操作数。
- `runtime.eventLoopDelayMs` 和 CPU 累计值属于整个进程；内存、池等待和连接数是读取时的快照，不能作为历史峰值。CPU user/system 单位为微秒，可用两次读取差值除以墙钟间隔计算占用。
- `summary.count` 是采样条数，`lastCount` 是最近的计数/节点数量；Outbox/重连/Gap Sync 计数是快照或累计计数，不能累加成事件数量。远端批量操作可能同时有批次和子事件采样。
- 浏览器上报属于客户端提供的、不可信诊断证据，服务端强制房间查看权限和上报来源，GET 只允许超级管理员。限制请求体 32KB、每批 100 条、每用户每分钟 12 次。
- 数据按 Node 进程保存，不跨实例聚合。多实例部署应分别读取，并比较 `processId`；负载均衡可能把上报与查询分配到不同实例。

## 本地验证范围

已验证权限拒绝、房间权限、来源不可伪造、字段脱敏、环形容量、游标、关闭开关、事务成功/失败的返回与释放连接、浏览器 observer 清理；通过隔离 Chromium 捕获受控 Long Task 并真实 POST 上报，通过 MCP SDK 验证工具注册、只读标记和 GET 转发。原有 direct、MCP incremental、事件桥和 clientId 聚焦回归通过；incremental 套件有 4 项 PG/API TODO，不能算作已执行验证。

新增验证用例按仓库现有 `.gitignore` 规则留在本地 `simple-mind-map/test/`，不改变测试文件排除策略。前端生产构建通过。尚未部署或采集生产数据，未进行真实 PostgreSQL 多人负载对比；这些本地验证不能证明生产根因或提速效果。
