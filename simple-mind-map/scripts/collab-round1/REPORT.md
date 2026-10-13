# 协作性能第一轮：采集与基线结果

日期：2026-10-13（Asia/Shanghai）。本轮只有可关闭的诊断事件与隔离采集工具，没有实施性能修复。

源码基于 d5793106，采集运行的具体源码 SHA、差异指纹、镜像 ID、浏览器构建指纹和开关保存在各 run_start/manifest 中。MCP-direct 保持关闭，历史检查点 200，布局偏好未改，编译器开启。桥接对照仅在隔离容器开启 Event Bridge。

## 浏览器与 MCP


### 基线 Bridge=0

| 配置 | 指标 | 样本 | 失败 | P50 ms | P95 ms | P99 ms | 最大成功 ms |
|---|---|---:|---:|---:|---:|---:|---:|
| 基线 Bridge=0 | firstOpen | 5 | 0 (0.0%) | 1245.6 | 2262.2 | 2262.2 | 2262.2 |
| 基线 Bridge=0 | lazyRequest | 13 | 0 (0.0%) | 33.5 | 138.7 | 138.7 | 138.7 |
| 基线 Bridge=0 | expand | 10 | 0 (0.0%) | 54.7 | 216.3 | 216.3 | 216.3 |
| 基线 Bridge=0 | collapse | 10 | 0 (0.0%) | 14.9 | 20.0 | 20.0 | 20.0 |
| 基线 Bridge=0 | mcpWrite | 20 | 0 (0.0%) | 135.6 | 209.5 | 306.9 | 306.9 |
| 基线 Bridge=0 | socketTrigger | 1 | 0 (0.0%) | 79.5 | 79.5 | 79.5 | 79.5 |
| 基线 Bridge=0 | commitReceive | 20 | 20 (100.0%) | 未测/未完成 | 未测/未完成 | 未测/未完成 | 未测/未完成 |
| 基线 Bridge=0 | commitApplied | 20 | 1 (5.0%) | 4121.7 | 5352.9 | 5352.9 | 5352.9 |

基线 Bridge=0：Gap Sync=2，Resnapshot 尝试=1，重复事件处理计数=0。

- 导航 coldContext：n=1，P50/P95/P99=2262.2/2262.2/2262.2 ms。
- 导航 cachedReload：n=4，P50/P95/P99=1187.0/1708.2/1708.2 ms。
- 懒加载请求：subtree=12，locate=1。
- 应用问题：[{"atMs":1791856438988,"kind":"delivery_issue","client":"browser","opId":"571f1f71-9294-4f08-b277-81d7ba808382","reason":"not_applied_as_operation"}]。
- 时钟校准偏移=-0.1 ms，不确定度=4.3 ms。
- 正确性抽检：{"atMs":1791856437402,"kind":"acked_persistence","expected":20,"actual":20,"ok":true}。
- 正确性抽检：{"atMs":1791856437770,"kind":"version_consistency","roomVersion":23,"clientVersion":23,"logContinuous":true,"noDuplicateOps":true,"roomMatchesLog":true}。

### 观测对照 Bridge=1

| 配置 | 指标 | 样本 | 失败 | P50 ms | P95 ms | P99 ms | 最大成功 ms |
|---|---|---:|---:|---:|---:|---:|---:|
| 观测对照 Bridge=1 | firstOpen | 5 | 0 (0.0%) | 1007.0 | 1960.3 | 1960.3 | 1960.3 |
| 观测对照 Bridge=1 | lazyRequest | 16 | 0 (0.0%) | 43.1 | 152.7 | 152.7 | 152.7 |
| 观测对照 Bridge=1 | expand | 10 | 0 (0.0%) | 52.6 | 82.4 | 82.4 | 82.4 |
| 观测对照 Bridge=1 | collapse | 10 | 0 (0.0%) | 12.1 | 19.9 | 19.9 | 19.9 |
| 观测对照 Bridge=1 | mcpWrite | 20 | 0 (0.0%) | 138.6 | 209.1 | 234.5 | 234.5 |
| 观测对照 Bridge=1 | socketTrigger | 1 | 0 (0.0%) | 20.8 | 20.8 | 20.8 | 20.8 |
| 观测对照 Bridge=1 | commitReceive | 20 | 0 (0.0%) | 14.8 | 38.6 | 86.2 | 86.2 |
| 观测对照 Bridge=1 | commitApplied | 20 | 0 (0.0%) | 1343.3 | 2265.0 | 2363.3 | 2363.3 |

观测对照 Bridge=1：Gap Sync=2，Resnapshot 尝试=2，重复事件处理计数=1。

- 导航 coldContext：n=1，P50/P95/P99=1960.3/1960.3/1960.3 ms。
- 导航 cachedReload：n=4，P50/P95/P99=992.4/1031.9/1031.9 ms。
- 懒加载请求：subtree=16，locate=0。
- 应用问题：[]。
- 时钟校准偏移=1.9 ms，不确定度=2.5 ms。
- 正确性抽检：{"atMs":1791856506705,"kind":"acked_persistence","expected":20,"actual":20,"ok":true}。
- 正确性抽检：{"atMs":1791856507054,"kind":"version_consistency","roomVersion":23,"clientVersion":23,"logContinuous":true,"noDuplicateOps":true,"roomMatchesLog":true}。

说明：firstOpen 是导航到可用状态，包含 1 次新 context 和 4 次缓存重载；合计不是冷启动 P99。Gap Sync、Resnapshot 和请求数量覆盖整个运行，包含打开及初始化，不单独归因 MCP。Commit→Applied 代表远端回调完成并推进连续版本，不是绘制完成；返回 false、未完成或只经快照恢复的操作不冒充逐条应用成功。Bridge=0 缺少 MCP 事件接收是当前配置下的预期观测，不代表 MCP 写入失败。缺失样本按观察窗口截尾，原始样本保留等待下界。

## 布局矩阵

每组 3 次，独立 Chrome 页面，实际调用当前源码布局。测量 doLayout 至 callback，包含布局期间的节点创建与尺寸测量，排除绘制。

| 可见节点 | 树形 | 紧凑 | n | 失败率 | P50 ms | P95 ms | P99 ms | 最大成功 ms |
|---:|---|---|---:|---:|---:|---:|---:|---:|
| 100 | wide | false | 3 | 0.0% | 387.8 | 768.4 | 768.4 | 768.4 |
| 100 | wide | true | 3 | 0.0% | 409.9 | 483.2 | 483.2 | 483.2 |
| 100 | deep | false | 3 | 0.0% | 488.7 | 627.4 | 627.4 | 627.4 |
| 100 | deep | true | 3 | 0.0% | 600.2 | 679.1 | 679.1 | 679.1 |
| 100 | mixed | false | 3 | 0.0% | 499.5 | 559.9 | 559.9 | 559.9 |
| 100 | mixed | true | 3 | 0.0% | 471.5 | 773.8 | 773.8 | 773.8 |
| 300 | wide | false | 3 | 0.0% | 1529.1 | 1583.0 | 1583.0 | 1583.0 |
| 300 | wide | true | 3 | 0.0% | 1434.9 | 1549.4 | 1549.4 | 1549.4 |
| 300 | deep | false | 3 | 0.0% | 1731.6 | 2188.4 | 2188.4 | 2188.4 |
| 300 | deep | true | 3 | 0.0% | 2330.1 | 2395.1 | 2395.1 | 2395.1 |
| 300 | mixed | false | 3 | 0.0% | 1190.5 | 1660.1 | 1660.1 | 1660.1 |
| 300 | mixed | true | 3 | 0.0% | 1455.0 | 1624.0 | 1624.0 | 1624.0 |
| 600 | wide | false | 3 | 0.0% | 2184.8 | 2571.2 | 2571.2 | 2571.2 |
| 600 | wide | true | 3 | 0.0% | 1673.1 | 1929.5 | 1929.5 | 1929.5 |
| 600 | deep | false | 3 | 0.0% | 2130.3 | 2576.4 | 2576.4 | 2576.4 |
| 600 | deep | true | 3 | 0.0% | 2282.8 | 2982.2 | 2982.2 | 2982.2 |
| 600 | mixed | false | 3 | 0.0% | 1645.5 | 1773.4 | 1773.4 | 1773.4 |
| 600 | mixed | true | 3 | 0.0% | 2471.3 | 3227.9 | 3227.9 | 3227.9 |
| 1000 | wide | false | 3 | 0.0% | 4108.7 | 4628.4 | 4628.4 | 4628.4 |
| 1000 | wide | true | 3 | 0.0% | 3915.4 | 4905.8 | 4905.8 | 4905.8 |
| 1000 | mixed | false | 3 | 0.0% | 4590.2 | 4658.8 | 4658.8 | 4658.8 |
| 1000 | mixed | true | 3 | 0.0% | 8696.9 | 8825.4 | 8825.4 | 8825.4 |
| 1000 | deep | false | 3 | 0.0% | 3922.5 | 4217.8 | 4217.8 | 4217.8 |
| 1000 | deep | true | 3 | 0.0% | 3917.9 | 5579.0 | 5579.0 | 5579.0 |

1000 层单链原采集出现 Windows Node JSON.stringify 溢栈，是采集器错误，已排除该组六条无效尝试并通过迭代序列化补测。此前中断和启动失败数据仍保留，不作为有效基线。三次样本的 P95/P99 等于最大值，不足以设生产阈值；这里的裸渲染器也不能替代真实编辑器的完整操作矩阵。

## 进程资源采样

| 配置 | 进程 | 样本 | CPU P50/P95/P99 % | RSS 峰值 MiB | 事件循环 p99 峰值 ms | 池等待峰值 |
|---|---|---:|---|---:|---:|---:|
| 基线 | collab | 33 | 11.8/128.3/142.9 | 191.3 | 920.6 | 0 |
| 基线 | mcp | 36 | 1.1/82.7/96.3 | 73.6 | 692.6 | 0 |
| 桥接对照 | collab | 29 | 10.8/124.0/136.9 | 192.9 | 572.5 | 0 |
| 桥接对照 | mcp | 30 | 0.9/53.0/68.5 | 79.2 | 56.2 | 0 |

CPU 100% 表示约占一个逻辑核。这里测整个进程，不单独归因编译器；本轮没有编译开关 A/B 或 CPU profile，不能据此批准后台拆分。

## 验证与边界

- 新增统计、隔离保护、重复/缺失/身份错误关联及观察器行为测试：8/8 通过。
- collabV2、collabV2.productFix、MCP event bridge 聚焦回归通过；生产构建通过。
- 既有 collabPassiveRefresh 测试：1 通过、1 失败；失败为测试上下文缺少 scheduleRemoteGeometryRender。已核对该测试与 Cooperate.js 均和 HEAD 完全一致，本轮未修改。
- 本轮是单浏览器、单服务实例的采集验证，不是多人/多实例性能验收；桥接重启恢复、多实例、完整重放、权限/SOP/历史/撤销重做矩阵留在后续对应阶段。
- 没有修复后数据，不宣称性能问题已解决。性能改善必须同时满足正确性和长尾门槛。

## 原始数据

- [2026-10-13T01-53-14-928Z](D:/mind-map-collab-round1-results/2026-10-13T01-53-14-928Z)
- [2026-10-13T01-54-31-333Z](D:/mind-map-collab-round1-results/2026-10-13T01-54-31-333Z)
- [layout-2026-10-13T01-44-47-623Z](D:/mind-map-collab-round1-results/layout-2026-10-13T01-44-47-623Z)
- [layout-2026-10-13T01-50-43-311Z](D:/mind-map-collab-round1-results/layout-2026-10-13T01-50-43-311Z)

完整原始数据根目录：D:/mind-map-collab-round1-results/。源码采集说明见同目录 README.md。

## 实际修改文件

- simple-mind-map/bin/collabV2/adapter.js：接收、应用、重复、缺口和快照诊断事件。
- simple-mind-map/bin/collabV2/performanceObserver.js：默认关闭、异常隔离的采集入口与可见树形统计。
- simple-mind-map/src/core/render/Render.js：布局耗时与树形记录，未改布局选择。
- simple-mind-map/scripts/collab-round1/README.md
- simple-mind-map/scripts/collab-round1/REPORT.md
- simple-mind-map/scripts/collab-round1/layout-entry.js
- simple-mind-map/scripts/collab-round1/layout-matrix.cjs
- simple-mind-map/scripts/collab-round1/metrics-check.cjs
- simple-mind-map/scripts/collab-round1/metrics.cjs
- simple-mind-map/scripts/collab-round1/preload.cjs
- simple-mind-map/scripts/collab-round1/report.cjs
- simple-mind-map/scripts/collab-round1/runner.cjs
- simple-mind-map/scripts/collab-round1/start.sh
