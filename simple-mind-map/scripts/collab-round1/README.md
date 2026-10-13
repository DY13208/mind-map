# 协作性能第一轮：采集与基线

只采集，不实施延迟水合、布局降级、编译拆分或检查点调整。

## 开关与行为

产品端只有 `globalThis.__COLLAB_PERF_OBSERVER__` 函数存在时输出诊断事件。默认无日志；接收器异常不影响协作。不增加协议字段、数据库列或 Outbox 数据。布局统计只在开启时遍历可见树，不修改布局选择。

`preload.cjs` 只用于测试容器，要求 `COLLAB_ROUND1_DIAG=1`、`MIND_MAP_SKIP_ROOT_ENV=1`、固定隔离数据库和主机。它记录 COMMIT 查询成功返回时刻、事务/锁 SQL 往返，以及每秒 CPU、内存、连接池和事件循环延迟。COMMIT 返回是客户端观测边界，不是 PostgreSQL 内部 WAL 提交时间。锁 SQL 往返包含数据库执行和网络，不能直接等同锁等待。

## 运行

在仓库根，先执行测试：

```powershell
node --test simple-mind-map/scripts/collab-round1/metrics-check.cjs
```

在 `web` 中构建当前源码，直接调用 CLI，避免 `npm run build` 后的 copy.js 写仓库 dist：

```powershell
$env:NODE_OPTIONS='--openssl-legacy-provider'
$env:PUBLIC_PATH='/'
node node_modules/@vue/cli-service/bin/vue-cli-service.js build --dest D:/mind-map-collab-round1-results/build
```

回到仓库根，串行运行，避免构建或两个采集器相互争用 CPU：

```powershell
node simple-mind-map/scripts/collab-round1/runner.cjs
node simple-mind-map/scripts/collab-round1/runner.cjs --bridge-control
node simple-mind-map/scripts/collab-round1/layout-matrix.cjs
```

默认基线与当前已核对配置对应：MCP-direct=0、Bridge=0、编译器开启、检查点=200。`--bridge-control` 仅在新建隔离容器开启 Bridge，仍关闭 MCP-direct，用于获得桥接延迟的观测对照；不代表已完成桥接验证或批准生产开启。

工具拒绝覆盖已有同名诊断容器/网络，固定绑定 127.0.0.1 的 21313/21314/21315/25513/26513。不会读取生产凭证或项目 .env。正常结束清理本次创建的容器和网络，原始文件保留。若进程被强行终止，先核对这些名字确属本次诊断，再清理。禁止泛化删除容器或卷。

## 样本含义

- 首次打开：导航开始至节点出现、协作 LIVE 且布局空闲；原始行区分新 context 和缓存重载。不是 LCP，不能混称首次冷启动的 P99。
- 展开/收起：实际 SET_NODE_EXPAND 命令至渲染结束及下一帧；通过真实 HTTP 懒加载。
- 懒加载：记录 /subtree、/locate 的请求数、完成/失败、浏览器端完整请求耗时。
- MCP 写入：真实 MCP tools/call 的完整响应耗时，固定 operation_id。
- Commit→Receive：COMMIT 返回至 adapter 的 Socket.IO op:event 监听入口，包含重复投递。
- Commit→Applied：COMMIT 返回至 adapter 完成远端回调并推进连续版本；不是绘制完成。回调返回 false 单独列为问题，不算成功应用。快照恢复不伪装成逐条事件应用。
- 原始时钟通过诊断专用端点进行十次校准，保存偏移和不确定度，提交时间校正后相关联。小于不确定度的差异不构成性能改善证据。
- 布局矩阵：100/300/600/1000 个可见节点，宽浅、单链深树、8 叉混合树，普通/紧凑各三次。测量 doLayout 至 callback，包含布局期间的节点创建测量，排除绘制。测试实例销毁，不更改用户偏好。深树通过 JSON 字符串传入页面，避免浏览器自动化对象序列化深度限制。

## 输出和验收限制

所有结果写入 `D:/mind-map-collab-round1-results/<运行时间>/`，不提交原始数据。保留 `client.jsonl`、`server-*.jsonl`、`summary.json` 和服务日志。布局目录另含 bundle、manifest、layout.jsonl 和 summary。失败/中断运行不覆盖，complete=false，不作为有效基线。

各指标输出 P50/P95/P99、最大成功耗时、最大尝试耗时、样本数和失败率。空样本用 null；收到但未应用、未逐条应用、重复接收/应用、Gap Sync 和 Resnapshot 单独输出。未完成的 attempt_started 也应保留，不能视作成功。

每组布局仅三次、MCP 每轮二十次，尾部分位数只是描述统计，不足以决定生产阈值。诊断资源争用、观察器开销和环境差异都可能影响绝对数值。本阶段只建立基线，没有修复前后性能改善结论。后续必须以相同构建方式、夹具、配置和操作序列重测，并同时通过正确性门槛。
