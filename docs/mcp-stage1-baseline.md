# MCP 阶段一：隔离验证入口

本入口用于复现与诊断，**当前预检仍失败，不是验收通过证明**。只使用专用测试环境；不连接业务数据库、业务房间或线上端点。

## 前置条件

- Docker、Git、Python 3.12+、项目依赖和 Playwright Chromium 已就绪。
- 专用 PostgreSQL：`127.0.0.1:25492`，角色 `mcp_test`，基础库 `mcp_incremental_test`；Redis：`127.0.0.1:16389`，本入口使用专用逻辑库 13。
- 每次运行创建自己的数据库、房间及带所有权标记的三个容器，清理前核对所有权；不修改既有业务资源。驱动默认只读预检，只有显式 `--run` 才创建测试资源。
- 检查并在隔离运行库准备 009/010/011/012。009 并发索引不能放事务，010 必须按脚本要求在事务中执行。普通写入请求不执行 DDL。

## 冻结镜像

从当前明确的代码状态构建新标签和新输出目录，不覆盖旧证据。运行前先同步并确认基线提交，不能把旧镜像当成最新工作树：

```powershell
$runId = Get-Date -Format 'yyyyMMdd-HHmmss'
$baselineRef = (git rev-parse origin/main).Trim()
$baselineTag = "mind-map-app:stage1-baseline-$runId"
$candidateTag = "mind-map-app:stage1-candidate-$runId"
$baselineOutput = "output/mcp-stage1-$runId/baseline"
$candidateOutput = "output/mcp-stage1-$runId/candidate"

node scripts/mcp-stage1-image.cjs baseline --ref $baselineRef --output $baselineOutput --tag $baselineTag
node scripts/mcp-stage1-image.cjs candidate --output $candidateOutput --tag $candidateTag
```

构建器从指定 Git 提交导出基线，从当前工作树冻结候选，保存源码/前端资源 hash、镜像 ID 与构建日志；拒绝覆盖已有目录/标签。镜像不包含 `.env`、本地数据、node_modules 或 output。需要源码清单与实际运行镜像一致，标签本身不能证明一致性。

## 聚焦自测与预检

```powershell
node scripts/mcp-direct-entry.unit.cjs
node scripts/mcp-http-lifecycle.unit.cjs
node simple-mind-map/scripts/collab-revision-completion.unit.cjs
node scripts/mcp-collab-load-worker.selftest.cjs
node scripts/mcp-collab-dispatch-summary.unit.cjs
node scripts/mcp-collab-final-readback.unit.cjs
node scripts/mcp-collab-attempted-intent.unit.cjs

$common = @('--variant', 'C', '--candidate-image', $candidateTag,
  '--candidate-source-manifest', "$candidateOutput/source-manifest.json",
  '--fixed-build', "$candidateOutput/web-assets")
node scripts/mcp-collab-performance.cjs @common
node scripts/mcp-collab-performance.cjs @common --run --smoke --mechanics-one-client
node scripts/mcp-collab-performance.cjs @common --run --warmup-precheck
```

先验证单客户端真实键盘输入、Tab、协作提交、ACK、内容读回，再运行十客户端预检。不要从延迟统计中移除失败/未完成项。MCP 以单调时钟锚定绝对 200ms 槽，迟到超过 50ms 的槽记未派发、不追赶；150 个预期槽分母不变。请求延迟与秒桶不依赖运行期间的墙钟跳变。无 worker ready 握手，启动偏晚会显式造成漏派发并使预检失败。

浏览器成功读回在同一回调中确认渲染空闲、UID、文本并捕获结果；超时保留受控现场，不重复提交输入。纯文本与产品段落包装采用受控比较，真实 HTML 差异及权威树 hash 仍严格校验。

## 三组比较与采样边界

| 组 | 代码与资源 | 事件桥 / MCP Direct |
| --- | --- | --- |
| A | 同一冻结基线镜像 | 关闭 / 关闭 |
| B | 与 A 完全相同 | 开启 / 开启 |
| C | 本轮冻结候选镜像 | 开启 / 开启 |

A/B 需要 `--baseline-ref`、`--baseline-image`、`--baseline-source-manifest`、`--baseline-build-dir`；迁移使用明确的 `--schema-image` / `--schema-source-manifest`。图结构、可见节点、操作与资源限制保持一致。正式验收每组预热 30 秒、采样 120 秒、三轮，C 另有十分钟混合负载、100 项批次与突发；自然视口与千节点全部绘制分别验证。

六组正式运行完成后，使用 `node scripts/mcp-collab-compare.cjs` 汇总：必需参数为 `--a-natural-dir`、`--a-full-dir`、`--b-natural-dir`、`--b-full-dir`、`--c-natural-dir`、`--c-full-dir`，值均为对应运行目录；另用 `--output-dir` 指定不存在的新输出目录。输入须含 summary、samples、events 和 browser-trace，短预检不能冒充正式三轮输入。

API 诊断按测试房间采集；只有本次自有隔离 MCP 进程采集全局游标，以保留解析前无房间归属的 HTTP 事件，并只落盘关联的受控字段。诊断权限不放宽，环缓冲 append-only，不保存正文、令牌或原始会话 ID。

当前已知缺口：驱动尚未落盘逐操作 `mcp-queue` / `mcp-write` 阶段；容器资源采样只覆盖三个应用，未覆盖 PG/Redis 容器 CPU/内存。`wait_event` 非空不是锁阻塞数量，HTTP 总区间不是事务时间，驱动派发迟到不是服务端排队时间。未补齐这些证据前不能宣称阶段一完成。

## 已有本地证据（不随代码提交）

- 环境/迁移：`output/mcp-stage1-20261016/environment.json`、同名 `.md`；009 有效，隔离库 010 触发器递增验证通过；业务库未迁移。
- 冻结镜像：`output/mcp-stage1-20261016/baseline-v2/` 与 `candidate-v3/`。历史候选基于 `66228924` 加产品补丁，不是后来 `9bbfc752` 合并后的全量性能验证。
- 最新十客户端原始结果：`output/playwright/mcp-collab-20261014/c-natural-2026-10-16T07-23-39-446Z-386245cd/`，状态 `precheck-fail`；包含 summary、事件、逐项样本、操作读回及诊断。
- 本地 10 秒 loopback 为 50/50 成功、0 missed；临时原始 JSONL 未保留，运行时未捕获源码 hash。它只验证调度机械链路，不能替代混合负载证据。

最新结论及第一阶段剩余项统一维护在 [阶段性交付状态](./mcp-collab-implementation-status.md)，此处不重复维护多轮过程报告。
