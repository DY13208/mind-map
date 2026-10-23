# P1/P2 稳定性收口与灰度准备

- 日期：2026-10-23
- 决策：P3 正式暂缓；本轮不做渲染引擎重构，不开发 P2-C / Canvas / WebGL。
- 本轮范围：未提交代码梳理、灰度验收标准、低侵入诊断、灰度方案、P3 再评估条件。
- **未部署、未提交、未推送、生产 `performanceFlags` 保持全关。**

证据等级：下列性能数字来自既有隔离浏览器或真实测试房 E2E，不是本轮新测。本轮只补诊断与文档。

---

## 1. 当前代码变更清单

HEAD 已包含 P1/P2 与个人视图修复（可见于 `41da2305` 一带）。**不要用后续提交覆盖这些工作。** 工作区相对 HEAD 的未提交内容如下。

### 1.1 已在 HEAD、默认关闭的性能功能

| 开关 | 默认 | 主要文件 | 行为 | 回滚 |
| --- | --- | --- | --- | --- |
| `scopedRemoteLineRender` | false | `simple-mind-map/src/plugins/Cooperate.js`，`simple-mind-map/src/utils/p1PerfPlan.js` | 远端样式补丁按计划刷新连线，避免整树线重绘 | 去掉 URL `perfFlags`；`defaultOptions.performanceFlags` 保持 false |
| `canvasTextMeasure` | false | `simple-mind-map/src/core/render/node/nodeCreateContents.js`，`p1PerfPlan.js` | 纯文本用 Canvas 测宽 | 同上 |
| `scopedRemoteGeometry` | false | `Cooperate.js`，`p1PerfPlan.js` | 远端几何变化才走整节点几何刷新 | 同上 |
| `deferDraftCopy` | false | `web/src/pages/Edit/components/Edit.vue`，`web/src/utils/draftFlushPlan.js`，`p1PerfPlan.shouldDeferDraftTreeCopy` | 草稿树拷贝可延后 | 同上 |
| `analyticEdgeBounds` | false | `simple-mind-map/src/utils/edgeGeometry.js`，`simple-mind-map/src/core/render/Render.js` | 解析边框替代部分 `getBBox` | 同上 |
| `lazyOffscreenPaint` | false | `Render.js`（`paintLayoutTree` / `paintViewport`），MiniMap 回退 `_connectorSpecs` | 视口外跳过 `node.render` | 同上 |

开关入口：

- 默认：`simple-mind-map/src/constants/defaultOptions.js` → `performanceFlags` 六项全 `false`。
- 测试开启：编辑页 `?perfFlags=scopedRemoteLineRender,canvasTextMeasure,...`（`Edit.vue` 约 1241 行解析）。
- 生产镜像/配置**不得**改默认值。回滚路径 = 去掉 query + 保持默认 false，无需回滚协议或数据库。

个人视图（与性能开关正交，已在 HEAD）：

- `web/src/utils/personalViewPolicy.js`、`personalAppearance.js`
- `CooperateDialog` 概览冻结/快照；`Render.expandToNodeUid` / `Cooperate.revealUid` 发 `{source:'reveal'}`
- 测试：`web/tests/personalViewPolicy.test.cjs`、`personalViewSession.test.cjs`、`overviewExpandRestore.test.cjs`、`simple-mind-map/test/userViewStateIsolation.test.js`、`tests/performance/personal-view-correctness.browser.cjs`
- 审计：`docs/p1-p2-stability-audit.md` 第 6–8 节

### 1.2 未提交：性能诊断（本轮新增，opt-in）

| 文件 | 作用 | 是否改业务 |
| --- | --- | --- |
| `web/src/utils/performanceDiagnostics.js` | `&perfDiagnostics=1` 时拆分 render 阶段，上报布局模型规模 | 否。仅包装计时，cleanup 还原原函数 |
| `simple-mind-map/bin/performanceDiagnostics.js` | 允许 `render-phase` / `render-scale` 入库 | 否。其它请求路径不变 |

阶段：`snapshot`（`checkIsNodeDataChange`）、`layout`（`doLayout`）、`index`（`rebuildNodeIndex` / `buildViewportIndex`）、`paint`（`paintLayoutTree` / `paintViewport`）、`plugin`（`node_tree_render_end` 监听耗时）、`other`（墙钟减去以上）。  
规模：`layoutModel`、`expanded`、`viewport`。**不要用服务端房间总节点数当规模。**

### 1.3 未提交：P3 必要性验证（只读诊断，无布局实现）

| 路径 | 类别 |
| --- | --- |
| `docs/p3-partial-layout-validation.md` | 诊断报告；已记录正式暂缓 |
| `tests/performance/p3-layout-necessity.browser.cjs` | 隔离实测脚本 |
| `output/p3-layout-necessity/` | 实测结果 |

### 1.4 未提交：无关 / 构建修复（保留，不丢弃）

| 文件 | 原因 |
| --- | --- |
| `web/src/utils/menuPlacement.js` | Docker `vue-cli-service build` 缺 `preferStackedSubmenu` 导出导致失败 |
| `Dockerfile` | `ENV CI=""` 避免 CI=1 把 size warning 当失败；`NODE_OPTIONS` openssl-legacy + heap |

这些**不是** P1/P2 功能，但与当前可构建镜像有关。不要在整理工作区时还原它们。

### 1.5 不在本轮工作区、但属于既有验证产物

已跟踪或本地输出（勿覆盖）：`docs/mind-map-rendering-architecture-optimization.md`、`docs/p1-p2-stability-audit.md`、`tests/performance/p1p2-compat-isolated.browser.cjs`、`p2b-first-render-repeat.browser.cjs`、`output/p2-optimizations/`、`output/p2b-first-render-repeat/`、`output/p1p2-compat-isolated/`、`output/personal-view-correctness/`、`output/real-room-acceptance/`。

---

## 2. 灰度验收标准

口径：**布局模型节点数** = `renderer.nodeIndex.size`（无索引时用 `nodeCache` 键数）。服务端 `format=nodes` 总数、首包 stub 节点数、视口绘制数必须分开记。

### 2.1 必须记录的规模

每次操作样本至少写：

- `layoutModel`（布局模型）
- `expanded`（`expand !== false` 的树节点）
- `viewport`（视口内绘制）
- 服务端总数（仅作对照，**不作门槛**）

真实 C2 大房先例：服务端 10000，首屏 layoutModel ≈ 2–10。隔离全展开 10000 才是 layoutModel=10000。

### 2.2 必须记录的操作与分位

在**真实展开树**（不是只打开房间）上记 P50/P95：

| 操作 | 记什么 |
| --- | --- |
| 展开/折叠 | 墙钟、layout、index、paint、other；展开后 layoutModel 变化 |
| 改字（同尺寸 / 变高分开） | 是否走 `doLayout`；同尺寸预期 `layouts=0` |
| 远端更新 | 本地应用墙钟、render 次数、是否改个人 expand |
| 视口平移/缩放绘制 | 长任务或帧间隔；P2-B 开启时视口外不应 `node.render` |
| 懒加载水合 | stub→subtree 后 layoutModel；个人偏好是否被 stub 覆盖 |

### 2.3 开关关闭回归

六项全关时，与优化前功能一致：

- 展开偏好仍只走 `{expand, theme, layout, themeConfig}`
- 搜索/定位不 persist
- 远端写入折叠枝不改个人 expand
- 导出/撤销/主题/布局切换可用
- 画布结果与全关基线一致（允许计时噪声，不允许结构/偏好差异）

### 2.4 六开关矩阵（测试房必须做完再进人）

| 模式 | 要求 |
| --- | --- |
| 全关 | 功能基线 |
| 单开每一项 | 无渲染异常、无协同丢操作、无 expand 串写 |
| P1 四项组合 | 远端改字 + 本地改字 + 展开 |
| P2 两项组合 | 空载/插入/平移视口 |
| P1+P2-A/B 全开 | 主灰度配方 |
| 开 → 关（去 query 刷新） | 行为回到全关，无残留脏绘制 |

独立单开目前主要靠代码路径隔离 + 部分兼容测试；**完整六项独立实测矩阵仍待测试房补完**（见第 5 节）。

### 2.5 异常分类（任一出现则该阶段失败）

- **渲染：** 缺线、节点错位、视口外永久空白、小地图与主画布连线不一致。
- **协同：** 丢操作、ACK 失败堆积、重连后树分叉。
- **个人展开：** F5/再进丢失、搜索污染偏好、概览把 stub 写成偏好、迟到 GET 盖本地、跨房串状态。
- **导出：** 图片/SVG/PDF 缺节点或与全关结果结构不一致。

---

## 3. 剩余性能诊断（已落地，低侵入）

仅 `&perfDiagnostics=1` 生效。关闭该参数时零包装。

上报：

- `kind=render-phase` `type=snapshot|layout|index|paint|plugin|other`
- `kind=render-scale` `type=layoutModel|expanded|viewport` `count`

用途：继续拆「其他耗时」，识别快照检查、插件刷新、索引重建。  
**没有新的实测证据前，不根据这些字段开新优化。** 已知隔离 10000 已展开插入：layout ~128 ms、index ~79 ms、paint ~13 ms（P1+A/B）、other ~115 ms；other 仍含命令调度、SVG.js、未包装插件等，需灰度时用新字段对照，而不是现在猜着改。

---

## 4. 正式灰度方案

生产默认配置保持六开关关闭。开启方式仅测试 URL / 明确授权名单，不改服务端协议。

### 阶段 0 — 内部测试房（当前可做）

- **开启条件：** 测试房或隔离房；登录已有测试账号；`?perfFlags=` 显式列出要开的项；建议同时 `perfDiagnostics=1`。
- **配方：** 先全关基线 → 再 `P1+analyticEdgeBounds+lazyOffscreenPaint`。
- **监控：** layoutModel（不是房间总数）；render P50/P95；phase 拆分；ack-failed；个人 expand 抽样（F5、切房、搜索）。
- **回滚：** 去掉 `perfFlags` 刷新；不改库、不回放协议。
- **退出标准：** 第 2 节关闭回归通过；无第 2.5 类异常；记下至少一种真实展开后的 layoutModel。

### 阶段 1 — 少量授权用户

- **开启条件：** 阶段 0 通过；名单内用户知情；仍用 URL 或仅测试环境入口，**生产默认仍关**。
- **监控：** 同上 + 导出抽检 + 协同 ack / 重连；按用户记录 layoutModel P50。
- **回滚：** 通知去掉 query；或服务端下发入口不含 `perfFlags`。一小时内渲染/协同/expand 异常即停。
- **人数：** 个位数。不自动扩大。

### 阶段 2 — 扩大范围

- **开启条件：** 阶段 1 无阻断异常；真实会话 layoutModel P50 仍远低于 3000 时**不必**为性能再扩；仅当授权用户稳定后再讨论默认入口。
- **监控 / 回滚：** 同阶段 1。扩大仍不得改 `defaultOptions` 生产默认值，除非另一次书面决定。
- **本轮明确禁止：** 自动部署、自动开生产开关、P2-C、P3、Canvas、WebGL。

### 与个人视图

性能灰度与个人视图修复可同房验证，但失败域分开：expand 异常停灰度并走个人视图回滚（代码层已在 HEAD）；性能异常只关 flags。

---

## 5. 性能监控指标

| 指标 | 来源 | 告警/解释 |
| --- | --- | --- |
| layoutModel P50/P95 | `render-scale` / 控制台 | 灰度规模口径 |
| expanded / viewport | 同上 | 避免把 stub=2 写成万节点 |
| render P50/P95 | `kind=render` | 与阶段 0 基线比，同规模下明显变差则查 |
| snapshot / layout / index / paint / plugin / other | `render-phase` | other 仍大只记录，不立刻优化 |
| longtask P95 | 已有 | headless 常为 0，真机才信 |
| ack / ack-failed | 已有 | 失败堆积停灰度 |
| client-state reconnect / outbox | 已有 | 协同健康 |
| 个人 expand 抽检 | 手工/E2E | F5、切房、搜索、迟到 GET |
| 导出抽检 | 手工 | 全关 vs 全开结构一致 |

---

## 6. P3 再评估触发条件（全部满足）

1. 真实房间会话的 **布局模型节点 P50 ≥ 3000**（不是房间总节点、不是偶发全展开一次）。
2. 该房间已经启用 P1 + P2-A/B，绘制已被视口裁剪。
3. 方案必须带全量布局影子比对，误差则回退全量 `doLayout`。
4. 不因为「房间有一万节点」启动局部布局。

详见 `docs/p3-partial-layout-validation.md`。当前真实大房 layoutModel 约 2–22，不满足。

---

## 7. 剩余风险与未测项目

| 项 | 状态 |
| --- | --- |
| 六开关独立开启矩阵 | 未在真实房间逐项跑完 |
| 两个登录用户 A/B | 未验证 |
| 真断线重连 | 未验证 |
| 远端插入折叠枝 | 测试房未插，避免改共享 C2 树 |
| 大图概览进入相位 | 未拍到冻结过程 |
| 导出 UI / 附件 / 关联线 / 小地图面板 | 未完整点 |
| 拖动帧时 | 未测 |
| 变高改字 vs 同尺寸改字 | 同尺寸已证不走 layout；变高未单列 |
| 诊断 `other` 再拆任务调度 | wrap 未覆盖 Vuex/命令队列；待灰度数据 |
| 多标签 PATCH 无 `updatedAt` | 已知后写覆盖；非本轮范围 |

这些不否定测试房灰度；**否定生产默认打开**。

---

## 8. 是否具备少量真实用户灰度条件

**具备：测试房 + 少量授权用户、URL 显式开启、生产默认关闭。**

不具备：生产全量默认打开、按房间总节点扩灰度、启动 P3。

建议顺序：先在测试房补完六开关矩阵与导出抽检，再邀请个位数授权用户；全程可一键去掉 `perfFlags` 回滚。
