# Mind-map Performance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复分析报告中的九类性能问题，支持约10–20张脑图、单图几千至上万节点，同时保留协同、撤销、备份、权限和导出行为。

**Architecture:** 保留现有 Vue 2 + SVG 引擎和 PostgreSQL/V2 协同架构，先消除重复绘制与资源残留，再解耦内容通知和快照、建立查询索引，优化局部数据库读写与目录加载，最后推进视口索引和增量布局。所有普通操作仍以服务端 revision/op-log 为权威；全图导入、导出与恢复保留独立完整路径。

**Tech Stack:** Vue 2、SVG.js、JavaScript/Node.js、PostgreSQL、Redis/Socket.IO、Yjs、现有 Node 行为测试、Vue SFC/Babel 装载、esbuild、Playwright。

---

## 状态、来源和授权范围

- 状态：**待用户确认的计划草稿**。本轮只克隆、初始化索引、写文档；没有实施修复或运行测试。
- 仓库目录：`/Users/seven/Documents/mind-map`；origin：`https://github.com/DY13208/mind-map.git`；分支：`main`。
- 固定基准：`d5793106098afe8a2ff9bbb60193bc25e5e45f88`，与分析报告基准一致。
- 来源：[性能分析报告](/Users/seven/Documents/Codex/2026-10-13/https-github-com-dy13208-mind-map/outputs/mind-map-performance-analysis.md)。其结论来自源码，不能当作当前线上性能采样。
- 配套：[测试驱动开发文档](2026-10-13-mind-map-performance-tdd.md)。TDD明确采用用户指定的“用例、红绿重构步骤”含义。
- 已执行 `codegraph init -i`，MCP status/context/explore 可用；索引有28,417节点、72,574关系。索引不是功能或性能验收证据。
- 文中仓库相对路径均相对于上述目录；“新增”文件是实施阶段拟创建的文件，本轮尚不存在。
- 本轮不创建修复分支、不提交、不推送、不创建PR、不部署、不修改生产开关或业务数据。收到文档确认后，才开始实施及隔离环境验证。

## 方案与范围

| 方案 | 覆盖程度 | 取舍 |
|---|---|---|
| **A：在当前架构中分阶段修复（推荐）** | 全部九类问题 | 每阶段独立测试，保护现有功能，方便定位和回滚 |
| B：一次替换为Canvas/WebGL新引擎 | 潜在规模上限更高 | 富文本、导出、概要、外框、选择和协同需大范围重做，超出本轮必要改动 |
| C：只改配置、折叠和历史上限 | 部分缓解 | 无法解决反馈环、引用保留和局部请求的全图处理 |

本计划采用A。I04的空间索引/布局算法工作放在后期，以先完成的正确性与性能基线指导具体范围。后台历史/旧缓存/归档风险列入观测项，本轮不顺便重做完整历史系统。

| 问题ID | 问题 | 任务 |
|---|---|---|
| I01 | 小地图重复绘制 | T01 |
| I02 | 切换脑图后旧编辑器残留 | T02 |
| I03 | 编辑复制整树历史 | T05、T06 |
| I04 | 绘制/连线/布局规模成本 | T13a、T13b |
| I05 | UID查找、多选重复扫描 | T04 |
| I06 | 局部读取仍处理整图 | T07、T08 |
| I07 | HTTP/MCP旧写入链路 | T09 |
| I08 | 目录预览查询和团队分页 | T10、T11、T12 |
| I09 | 外框元素引用累计 | T03 |

依赖顺序：T00 → T01/T02/T03 → T04 → T05 → T06；T00 → T07 → T08；T00 → T09；T00 → T10 → T11 → T12；T04/T05/T06 → T13a → T13b；全部已实施任务 → T14。前端、后端和目录可在独立分支/工作树中并行，共享文件修改串行整合。

每个任务按小步骤执行：先写一个行为用例 → 运行并确认因现有缺陷而失败 → 最小实现 → 相应用例及必要回归变绿 → 重构并再次验证。没有先观察到有效RED，不能把后补测试称为TDD。新测试未收集、缺依赖、无法登录或连接失败，不是有效RED。

## 实施任务

### T00：测试收集、隔离环境和基线

**Files:** 修改 `.gitignore` 的测试目录规则，仅放行本计划需要版本管理的测试/配置；新增 `tests/performance/fixtures.cjs`、`fixture-contract.cjs`、`engine-harness.cjs`（均在同目录）、`simple-mind-map/e2e/performance/playwright.config.cjs`、该目录的 `renderer.spec.cjs` 和 `directory.spec.cjs`；复用现有 `tests/expand-browser-perf.cjs`、`tests/hyperlink-preview.browser.cjs` 和 `docker/mcp-incremental-test.compose.yml`。

1. 先确认新增测试能被Git与专项runner收集。当前 `/tests/`、`/simple-mind-map/test/`、`/web/tests/`、`*.test.*`、`*.spec.*`均忽略新文件；既有文件已被跟踪。只对所需目录/文件添加精确放行规则，继续忽略结果、日志、数据库和凭据。
2. 专项Playwright配置独立使用 `testMatch: '*.spec.cjs'`；现有V2配置只收集 `collab-v2-core.spec.js`，不能直接复用后宣称新增spec已执行。
3. 采用真实引擎和真实Vue组件装载。浏览器fixture为合成数据；引擎测试可离线，编辑器协同/PG测试在显式隔离环境执行。
4. 按1000/5000/10000节点，以及浅宽、深窄、概要、外框、自定义位置建立固定夹具。记录小地图开关、布局、字体、可见节点数、已加载节点数、机器/浏览器/Node版本。
5. 保存功能真值与修改前性能原始样本。本机Node为26.3.0，仓库Docker使用Node20；实施时优先以同一Node20隔离基线验证构建/服务，不把不同运行时的结果混合。

**Command after implementation（仓库根目录）:** `node tests/performance/fixture-contract.cjs`；`node simple-mind-map/node_modules/@playwright/test/cli.js test --config simple-mind-map/e2e/performance/playwright.config.cjs --list`；`git check-ignore --no-index tests/performance/fixture-contract.cjs simple-mind-map/e2e/performance/renderer.spec.cjs`。最后一条预期无输出且exit=1，表示不再被忽略；缺文件/依赖不是RED。

**Acceptance:** 测试被实际收集，新增文件可提交；夹具节点/关系数量准确；隔离配置校验通过。缺环境标为BLOCKED，不能标PASS。依赖安装、容器启动与夹具写入均留到用户确认后。

### T01：小地图反馈与刷新职责（I01）

**Files:** 修改 `web/src/pages/Edit/components/Navigator.vue`、`simple-mind-map/src/plugins/MiniMap.js`、`simple-mind-map/index.js`；新增 `tests/performance/minimap-lifecycle.browser.cjs`。

1. RED：真实组件打开小地图、性能模式开启，等待首次图像后观察三个刷新窗口，验证静止期间不会继续触发主画布强制绘制；旧代码预期失败。
2. GREEN第一步只断开“临时取图→渲染结束→再次取图”反馈，采用布局/内容版本与任务generation去重；关闭、卸载和过时异步回调不可继续应用。
3. 将平移/缩放刷新分成视口框更新；内容改变才重建小地图。独立轮廓绘制使用布局坐标，不调用主画布全量导出。
4. 保留明确SVG/图片/PDF导出的完整绘制路径，不从 `getSvgData()` 全局删除强制绘制。
5. GREEN/REFACTOR：覆盖拖动小地图、内容更新、性能模式关闭、关闭/重开、导出，见TDD R01–R03。

**Command:** `node tests/performance/minimap-lifecycle.browser.cjs`。

### T02：编辑器资源释放（I02）

**Files:** 修改 `web/src/pages/Edit/components/Edit.vue`、`simple-mind-map/index.js`、必要的渲染任务取消代码；新增 `tests/performance/editor-lifecycle.browser.cjs`。

1. RED：同一应用内进入/退出编辑器10轮，本组件监听数回到基准；退出后旧回调不保存、不渲染。
2. GREEN：匿名保存监听改具名函数，逐个 `$off(event, handler)`，不移除其他组件的监听；清理 `storeDataTimer/storeConfigTimer` 与异步任务。
3. 定义退出顺序：提交当前文本 → 合并最后一次有效草稿/配置保存 → 注销监听 → 取消迟到任务 → 销毁引擎并释放持有引用。页面全局引用仅在仍属于旧实例时清理。
4. 销毁释放树、节点/概要索引、历史、选中缓存与渲染任务；避免迟到水合或小地图回调访问新实例。
5. GREEN/REFACTOR：对正在编辑、断网备份和水合中退出进行回归；Heap retained size作为辅助证据，见R04–R06。

**Command:** `node tests/performance/editor-lifecycle.browser.cjs`。

### T03：外框数组与重复版本更新（I09）

**Files:** 修改 `simple-mind-map/src/plugins/OuterFrame.js`；新增 `tests/performance/outerframe-lifecycle.browser.cjs`。

1. RED：F个外框连续渲染100轮，保留文本元素数量对应当前外框，删除全部后为0。
2. GREEN：清理后清空数组；先解决引用累计，再以groupId复用无变化元素、合并同版本双事件。
3. 验证文字/样式/范围/点击、折叠、移动、布局切换及撤销仍正确。
4. REFACTOR：集中元素释放，不以截断数组丢弃活跃外框；具体TDD用例见R38–R40。

**Command:** `node tests/performance/outerframe-lifecycle.browser.cjs`。

### T04：UID索引与批量选择（I05）

**Files:** 修改 `simple-mind-map/src/core/render/Render.js`、`simple-mind-map/src/plugins/Select.js`、必要的节点生命周期方法；新增 `tests/performance/uid-selection.browser.cjs`。

1. RED：真实查询普通/概要/嵌套概要节点，查找工作量随N增长；多选恢复产生重复遍历。
2. GREEN：渲染换代建立UID→当前实例索引，插入/删除/概要/水合时维护，退出清空；不返回退休实例或仅原始数据对象。
3. 激活UID集合用Set/Map去重，保留外部activeNodeList顺序与协同编辑限制；批次只发送兼容的聚合通知。
4. 回归框选概要子树、右键单选、最后鼠标位置检测、折叠/重开、布局切换、远端更新。
5. REFACTOR：索引构建允许O(N)，单次查询不能重建；见R10–R12。

**Command:** `node tests/performance/uid-selection.browser.cjs`；现有选择回归见TDD命令清单。

### T05：内容通知与撤销存储解耦（I03前置）

**Files:** 修改 `simple-mind-map/src/core/command/Command.js`、`simple-mind-map/src/plugins/Cooperate.js`、`web/src/pages/Edit/components/Count.vue`、`Edit.vue`、必要的Outline/Navigator消费者；新增 `tests/performance/history-notifications.browser.cjs`。

1. 先写保护用例：普通内容编辑通知、统计、备份、协同提交仍发生，个人展开/选中不创建内容撤销步骤，远端应用不回声提交。
2. 新增明确的增量内容变化契约，至少包含命令/来源、受影响UID、contentRevision；数据消费者按变化范围处理。兼容确实需要树的原有消费者，不依赖历史快照才发通知。
3. 内容通知在命令实际生效后发出，异步命令必须对应最终应用结果；跨一次复合命令合并一次。
4. 内容通知按有效逻辑操作发生；IndexedDB物理备份按3秒窗口合并，最后有效内容最终落盘，退出收尾保存捕获原房间key，不能写到新房间。不把当前大于400节点的非协同本地图跳过草稿写入的行为静默改成持续全量保存。
5. Count等消费者改为增量更新并保持当前统计范围；新增/删除/水合按实际新增范围处理。测试同时计数整个通知链的整树复制、序列化与Count遍历工作量，不能把开销转移到新方法。节流备份、显式导出和整树替换的完整树成本单独记录。
6. GREEN/REFACTOR：见R07–R09；先通过通知保护再执行T06。

**Command:** `node tests/performance/history-notifications.browser.cjs`。

### T06：V2重复快照与本地历史预算（I03）

**Files:** 修改 `Command.js`、`Cooperate.js`、`simple-mind-map/src/constants/defaultOptions.js`；更新 `simple-mind-map/test/c2RendererCorrectness.browser.test.js` 中依赖V2 history.length增长的旧断言。

1. RED：V2普通内容修改不复制已加载整树，现有 `getCopyData()` 调用预期违反；同时必须通过T05通知保护。
2. GREEN：V2撤销/重做使用服务端op-log，正常增量编辑不积累重复字符串快照；明确连接建立/断线/转为本地图时的模式状态。
3. 非协同本地图保留正常back/forward。本批先加历史总序列化字节预算和可用范围说明，不同时重写所有本地命令逆操作。拟议预算32MiB/图、最多100条，作为待确认默认；该预算不等于浏览器Heap上限。
4. 不设置“超预算后连当前有效基线也丢弃”的行为；单次快照过大时保留至少当前状态并提示可撤销范围受限，导出/手动保存仍可用。
5. 回归混合Direct/legacy删除恢复、概要/附件、刷新、远端pause恢复；见R07–R09。

**Commands:** `node tests/performance/history-notifications.browser.cjs`；`npm --prefix simple-mind-map run test:collab:history`；隔离浏览器运行 `npm --prefix simple-mind-map run test:c2:renderer-correctness`。

### T07：UID定向读取与一致版本（I06）

**Files:** 修改 `simple-mind-map/bin/mindApi.js`、`storage.js`、`roomNodes.js`，复用 `nodeQuery.js` 查询能力但保留原DTO；新增 `simple-mind-map/test/nodeUidRead.test.js`、`nodeUidRead.pg.test.js`。

1. RED：请求少量UID时不调用全图snapshot/decode/hash；响应契约与旧 `mindDoc.nodesByUids()` 一致。
2. GREEN：定向查询UID、完整直属children及准确计数；输入顺序、最多200个、删除过滤、重字段裁剪、业务字段与错误状态保持。
3. 房间revision、节点、关系与计数在同一 `REPEATABLE READ READ ONLY` 事务读取，不能用默认READ COMMITTED多次查询冒充一致快照。
4. 未初始化/legacy来源的兼容路径显式分离、测量；已经初始化的V2路径不能暗中回到全图读取。
5. 并发栅栏验证读R时另一连接提交R+1，返回全部属于R，下一请求属于R+1；见R13–R15。

**Commands:** `node simple-mind-map/test/nodeUidRead.test.js`；隔离PG运行 `node simple-mind-map/test/nodeUidRead.pg.test.js`。

### T08：子树计数与有限版本缓存（I06）

**Files:** 修改 `simple-mind-map/bin/roomNodes.js`、`descendantCounts.js`、`storage.js`（均在bin目录）及经CodeGraph/SQL写者清单确认的维护/修复入口；新增 `simple-mind-map/bin/nodeCountCache.js`、`simple-mind-map/test/subtreeCounts.pg.test.js`、`simple-mind-map/migrations/010_node_count_cache_generation.up.sql` 及对应 `.down.sql`（拟新增，实施前核对编号）。

1. RED：局部分页不把该图全部UID/parent传到Node重复建图；同revision热读不再次计算相同范围。
2. GREEN：直属计数做所需parent聚合，后代计数只遍历目标范围，合并重叠子树；安全预览/shallow/deep接同一服务。
3. 首先完成局部精确查询，再加入有限缓存。选择共享持久化generation方案：迁移增加 `rooms.node_counts_generation bigint NOT NULL DEFAULT 0`；权威树维修/修复即使保持revision，也必须在同事务推进该generation。普通op-log写入已有revision递增，缓存键读 `(roomKey, revision, canonicalScope, node_counts_generation)`，不能用进程内epoch替代。拟议最多256项且4MiB，每次在一致快照内读PG revision/generation再选缓存。
4. 版本0、未初始化表绕缓存；未审计/升级的写者或未完成迁移存在时，全实例计数缓存保持关闭。新增缓存开关默认关闭，先确认所有维护/恢复/导入写者满足共享版本契约再启用；通知仅加速失效。旧在途结果不能覆盖新键，ACL仍逐请求判断。回滚先禁用缓存及generation依赖，再按迁移兼容步骤回退，不能先删除被运行代码查询的列。
5. 准确root后代数或覆盖全图的冷请求仍可能O(N)，单独测量，不能承诺所有冷读O(1)。见R16–R18。

**Command:** 隔离PG运行 `node simple-mind-map/test/subtreeCounts.pg.test.js`。

### T09：HTTP/MCP Direct准入与混合路径一致性（I07）

**Files:** 修改 `mindApi.js`、`mcpDirectPolicy.js`、必要的 `collabV2/directApplier.js`、事件桥；新增 `simple-mind-map/test/directHttpParity.pg.test.js`，扩展现有MCP与桥用例。

1. 先写准入矩阵和Direct/legacy结果差异用例。首批仅UID insert、经验证的非结构字段update、常规delete；自定义UID、expected、根/SOP守卫、墓碑与field version语义必须一致。parity比较规范化后的结构/业务结果、客户端应用事件后的结果，以及分别执行逆操作后的恢复结果；legacy的nodes和Direct的rows等原始DTO不要求字面相等。
2. HTTP使用服务端校验身份与ACL，不能伪造verifiedMcpSource。复用原事务序列：节点、operation、outbox原子提交，revision唯一递增。
3. 只允许写入前“不支持此shape”选择慢路径。403、409、SQL异常、提交后响应丢失不得catch后另写legacy。MCP相同operation_id重试保持同principal/digest幂等、同ID不同业务拒绝。普通HTTP本批保留现有重复ID返回旧结果的契约：当前没有通用HTTP请求摘要比较，不能要求同ID不同body必被拒绝；不在性能修复中暗中新增持久化摘要协议。
4. move/reorder、keepChildren、batch、undo/redo逐项测试后再扩范围；导入/整树替换保留完整路径。batch若纳入，必须补事件桥的 `batch.applied` 契约及断线补偿，当前桥不支持该事件。
5. 默认开关不变，不自动生产开启。若新增HTTP独立开关默认关闭；生产启用属于后续发布事项。增量响应不得通过 `applyCommittedLive/getRoomSnapshot` 又加载整图。
6. 验证双实例、通知丢失、重复广播、ACK顺序、归档日志恢复，见R19–R22。

**Commands:** `node simple-mind-map/test/mcpIncremental.test.js`；`node simple-mind-map/test/mcpRecoveryCompat.test.js`；`node simple-mind-map/test/mcpEventBridge.test.js`；隔离PG/双实例命令见TDD。

### T10：预览授权复用与有界SQL（I08）

**Files:** 修改 `simple-mind-map/bin/fileSystem/http.js`、`engine.js`、`pgStore.js`；新增 `simple-mind-map/test/cardPreview.pg.test.js`。

1. RED：当前请求已获完整房间授权后，预览不重复验同身份/同房间权限，也不读无关room_user_state；直接engine调用无可信全房间上下文仍验权。
2. GREEN：复用上下文必须标识完整room scope并匹配房间/身份，不能仅检查canView。`req.roomAccess`可能来自node-share cookie并含shareId；仅持有子树分享、没有全房间授权时，本批全图card-preview保持拒绝，包括缓存预热后与不同分享scope。不引入子树预览新接口。不接受body/query自报授权；缓存命中仍执行当前授权判断，撤权/删除/回收站保持错误语义。
3. 保留API当前根＋最多6个一级孩子×每个2个孩子的sketch契约，用索引有界查询最多19节点；不是先枚举全部再LIMIT。版本与投影使用同一SQL快照/一致读事务。
4. 真实PG记录返回行数、SQL次数、执行计划与buffers。缺索引可能仍扫描，不以出现LIMIT作为性能证明。
5. 验证空图、浅宽、深窄、deleted节点、文本与顺序；见R23–R25。

**Commands:** `npm --prefix simple-mind-map run test:collab:files`；`node --test simple-mind-map/test/previewSketch.test.js`；隔离PG运行 `node simple-mind-map/test/cardPreview.pg.test.js`。

### T11：预览共享队列、取消和身份/版本缓存（I08）

**Files:** 新增 `web/src/services/previewRequestQueue.js`、`web/tests/cardPreviewQueue.test.cjs`；修改 `roomService.js`、`RoomCard.vue`、必要的会话缓存清理；新增 `tests/performance/card-preview.browser.cjs`。

1. RED：100个任务实际并发不超过4；同identity去重；一个订阅取消不破坏其他订阅。
2. GREEN：队列接真实service的AbortSignal，排队取消不开始、全部订阅取消才abort；保留IntersectionObserver。
3. 请求捕获身份/session、room、revision、generation；响应按实际服务端revision缓存。旧revision慢响应不展示为新revision；401/403/退出清缓存，Abort不缓存降级结果。
4. 拟议LRU上限128项且4MiB；不缓存权限决策。浏览器验证真实卡片在观察区域（视口＋现有120px预取边界）之外不请求，进入观察区域加载，卸载取消；懒加载与并发上限分别验证。
5. GREEN/REFACTOR：见R26–R28。

**Commands:** `node web/tests/cardPreviewQueue.test.cjs`；`node tests/performance/card-preview.browser.cjs`。

### T12：团队分页及全部调用方迁移（I08）

**Files:** 修改 `simple-mind-map/bin/teamSpace.js`、`web/src/services/teamService.js`、`FilesPage.vue`、`SpaceDetailPage.vue`、`SopRegistry/Index.vue`；新增 `simple-mind-map/test/teamRoomsPaging.pg.test.js`、`web/tests/teamRoomsPaging.test.cjs`。

1. RED：跨两页无遗漏/重复，搜索与角色/目录过滤在分页前，未授权或跨企业拒绝。
2. GREEN：沿现有URL新增 `folderId/q/role/sort/order/limit/offset`，默认20、上限100；返回 `{items,list,total,limit,offset}`，排序追加room_key稳定打破同值。采用offset，暂不声称keyset cursor。
3. 新增 `listRoomsPage()` 返回DTO，保留旧listRooms数组契约至调用方迁移完成。FilesPage和SpaceDetail接pager，SOP选择器采用远程搜索/加载更多，使第21张以后可达；保留已选项。
4. 保持标题/创建者/目录搜索语义、根目录搜索范围、房间角色与团队角色区分；支持title/updatedAt/createdAt/lastOpenedAt对应服务器排序，未具备字段者在UI明确禁用。DTO补revision/content/resource更新时间。
5. 普通翻页只重载房间页；目录与团队按结构变更失效，子目录计数一次建索引。删除末页、无结果、非法参数与三个调用方回归见R29–R31。

**Commands:** `node simple-mind-map/test/teamSpace.test.js`；`node web/tests/productShell.services.test.cjs`；新增测试见TDD。

### T13a：视口节点和连线索引（I04）

**Files:** 修改 `Render.js`、`MindMapNode.js`、`simple-mind-map/src/utils/layoutSlices.js`，新增 `simple-mind-map/src/utils/viewportIndex.js`、`tests/performance/renderer-viewport.browser.cjs`。

1. RED：固定可见范围、增加展开树N，视图变化不应遍历整个树或更新全部边。
2. GREEN：布局换代建立有界空间索引，平移/缩放只处理进入/离开/可见候选；边用保守路径包围盒裁剪，包含两端在外但路径穿过视口的边。
3. 模型数据与DOM显示分离，隐藏不能丢子树、选择或概要；显式导出保持完整展开内容。任务generation取消过时绘制。
4. 分帧预算拟议8ms；不把每节点setTimeout扩散当作完成全部阶段切片。见R32–R34。

**Command:** `node tests/performance/renderer-viewport.browser.cjs`。

### T13b：布局重复移动与局部更新（I04）

**Files:** 修改 `simple-mind-map/src/layouts/Base.js`、`LogicalStructure.js`、`MindMap.js`，必要布局兼容分支；新增 `tests/performance/layout-work-budget.browser.cjs`。

1. RED：宽多层夹具实际坐标写入量呈二次方；保持小图坐标golden、间距、连线端点和无重叠真值。
2. GREEN：先两遍计算子树尺寸和定位，使用子树位移量避免反复移动兄弟后代；没有实际尺寸变化的内容更新不全图定位。
3. 建立脏节点/祖先/受影响兄弟范围。完整布局用于首次加载、切换布局和必要恢复；局部布局不得破坏customLeft/customTop、浮动节点、概要范围和紧凑路由。
4. 纯计算可进一步移Worker，但仅在DOM测量已隔离、传输成本已测量后采用，不把Worker作为首批必需依赖。
5. 先逻辑/思维布局后其他布局，未迁移布局仍走正确完整路径，不能宣称全部布局已优化；见R35–R37。

**Commands:** `node tests/performance/layout-work-budget.browser.cjs`；`node --test tests/layout-slices.test.cjs`；隔离环境运行现有C2正确性。

### T14：功能、性能与交付

1. 按TDD覆盖表核对所有已实施任务，逐项保留RED、GREEN、必要回归和原始性能记录。
2. 1000/5000/10000节点的单客户端，及6001节点13真实contexts的在线协同分开测量；13contexts同实例/双实例分层记录，不用分批LCP声称同时冷启动。
3. 区分提交→ACK、数据应用、DOM完成和视口可见；必须实际收到op:event再声称实时通知路径通过。
4. 验证权限、幂等、恢复、墓碑、父子顺序、附件/概要/外框、导出、本地备份和退出资源回收；必要构建使用隔离Node20环境并保留产物/日志。
5. 后续提交分成可独立回滚的变更；创建PR时附功能证据、测量范围与限制。生产部署和生产开关放量不属于本轮文档授权。

## 待确认的验收策略

硬行为门槛见TDD，必须全部满足。性能门槛采用同环境修改前/后对照，未取当前基线前不填“已达标”。拟议：单节点热读/写P95至少降低40%；固定目标UID、直属孩子和目标子树范围时，1k→10k图P95倍率不超过2；大图展开/缩放P95退化不超过10%，布局工作量先证明线性；进入退出10轮后监听数和旧保存任务回到基准。root准确后代冷读、大子树删除、全图导入/导出单独记录，不套局部操作常量成本门槛。

不承诺当前报告中的旧510.55ms基线适用于本机，不承诺全部问题修完即达到某个绝对毫秒数。所有数值预算和相对目标均为本次待确认建议；采样环境锁定后再写入实施验收配置。

## 确认点

请确认是否接受：全部九类问题的分阶段范围；先T00–T03再逐步推进；TDD要求真实RED→GREEN→REFACTOR证据；上述拟议预算与相对门槛；暂不启用生产开关或部署。文档确认前不执行后续安装、测试、源码修改、提交或发布。
