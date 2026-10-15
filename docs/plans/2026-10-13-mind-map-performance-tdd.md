# Mind-map 性能修复 TDD 文档

**状态：待用户确认；全部用例均为待实现、待运行。** 本文采用“测试驱动开发”的含义，重点是行为用例与RED→GREEN→REFACTOR。配套：[实施Plan](2026-10-13-mind-map-performance-plan.md)。基准提交：`d5793106098afe8a2ff9bbb60193bc25e5e45f88`；仓库根目录：`/Users/seven/Documents/mind-map`；日期：2026-10-13。

本轮只完成克隆、CodeGraph初始化和文档编写，没有新增测试代码、观察RED、实施修复、运行GREEN、启动服务或压测。下文“预期RED”是需要后续证实的预期，不是已发生结果。既有仓库测试/文档也不构成本轮通过证据。

## 执行规则

1. **一个行为一轮。** 写真实生产代码的行为用例，先在基准上运行。只能因所测缺陷而FAIL；模块不存在、测试未收集、浏览器/数据库缺失、认证失败、拼写错误均为环境/用例错误，不是RED。
2. **RED记录。** 保存命令、SHA、夹具、实际失败断言、exit code、用例数和必要trace。若用例已PASS，标为既有保护用例，不宣称证明修复；补写能抓住缺陷的用例。
3. **GREEN最小实现。** 每轮只修改对应生产路径；用相同用例变绿，再运行该任务的必要回归。不得删除断言、降低门槛或仿制一个测试专用算法来变绿。
4. **REFACTOR后重跑。** 仅在GREEN后清理重复逻辑；重新验证。确定性缺陷可临时撤回局部修复证明用例再次FAIL，然后恢复；不要把生产行为改动混入测试数据准备。
5. **真实行为优先。** 装载真实类、Vue组件和生命周期；spy继续调用原方法。transport、时钟、数据库连接边界可控；不能只检查源码里有没有Map/LIMIT/$off，不能只mock返回值后断言mock被调用。
6. **分层证据。** 单元/VM契约、真实PG、离线真实浏览器、完整编辑器和跨实例E2E分别记录。少量DOM不等于少量模型/布局工作；一次HTTP200不等于持久化、同步可见或性能达标。

## 前置与收集

当前 `.gitignore` 忽略新增测试；T00先精确放行拟提交的测试、配置与夹具，继续忽略结果和秘密。现有V2 Playwright配置仅匹配 `collab-v2-core.spec.js`，专项配置必须明确收集新增spec，并用 `--list`证明。

| 层级 | 基建 | 证据限制 |
|---|---|---|
| Node生产方法契约 | 现有VM/Babel装载、真实engine+MemoryStore | 不证明浏览器渲染或真实PG扫描量 |
| Vue组件 | 复用 `web/tests/nodeAttachmentPreview.component.test.cjs` 的SFC+Babel方式 | 方法测试不代替实际挂载/退出生命周期 |
| 离线浏览器 | esbuild打包真实引擎/Vue；Playwright已安装Chromium | 不固定要求msedge；不依赖生产服务 |
| PG/API | 显式隔离数据库、真实生产SQL与连接 | fake DB不能证明扫描、锁和事务隔离 |
| 协同E2E | 隔离双应用/Redis/PG及真实浏览器 | ACK、数据、DOM、视口四层延迟分别记录 |

依赖安装和容器启动只在文档确认后。现有Docker使用Node20，本机Node26；同一批对照固定运行时。PG测试入口在import storage/loadEnv前设置 `MIND_MAP_SKIP_ROOT_ENV=1`，校验显式测试连接。当前隔离Compose使用loopback映射PG端口25492、数据库 `mcp_incremental_test`；如果冲突，调整专用隔离配置及护栏，不能转用默认数据库。凭据通过隔离环境提供，日志/文档不记录值。

新增runner遇不匹配数据库、非允许测试地址或缺少显式环境时必须退出非0，不执行initSchema/seed。浏览器测试会创建/替换合成房间，仅指向校验通过的隔离服务。现有 `productShell.browserSmoke.cjs` 默认连接8989、读.env并写数据，不作为本计划默认入口。

## 夹具和观测

| 夹具 | 规模/形状 | 用途 |
|---|---|---|
| F01 | 1k/5k/10k，相同可见窗口、不同展开模型规模 | UID查询、视口绘制工作量 |
| F02 | 根下k分支、每支至少两个叶子 | 宽多层布局重复移动 |
| F03 | 深窄树＋部分懒加载/分页 | 计数、knownVersion、折叠水合 |
| F04 | 概要后子树、嵌套概要、浮动/自定义坐标、紧凑布局 | 索引、布局、选择正确性 |
| F05 | F个外框、富文本/公式/图片/标签/链接/附件 | 功能与资源释放 |
| F06 | 60张团队脑图，分目录、重复标题/时间、不同角色 | 分页与SOP选择器可达性 |
| F07 | 浅宽1k/10k/30k、深窄图 | 有界card预览SQL |
| F08 | 6001节点、13contexts，单/双实例 | 真实协同与恢复E2E |

记录总节点N、已加载节点L、展开节点E、可见候选V、请求UID数M、完整直属children数C、目标子树范围S。不得把N与L/E/V混用。计数通过真实方法调用、关系访问、坐标写入、SQL返回/访问行、实际trace获得；根后代精确冷读和大范围删除允许按S或N付费。

## 用例、预期RED、GREEN与重构

### T01 / I01：小地图

**新增文件：** `tests/performance/minimap-lifecycle.browser.cjs`。

| ID | 行为与断言 | 预期RED | GREEN最小变化 | REFACTOR/保护 |
|---|---|---|---|---|
| R01 | 真实Navigator打开＋性能模式开，首次图像就绪后静止三个500ms窗口；绘制/导出计数不继续增长 | render_end使下一轮强制绘制再次安排 | 区分临时导出事件，generation/版本去重 | 计时器释放与刷新职责分开 |
| R02 | 平移/缩放后视口框正确，内容/布局版本未变时不调用整图导出 | view_data_change触发全图取SVG | 视口框独立更新 | 小地图点击/拖动和视口框拖动保持 |
| R03 | 快速内容更新、关闭/重开、卸载后迟到图片不覆盖当前图；显式SVG/图片/PDF包含完整展开图 | 旧任务应用或关闭后继续绘制；导出为保护用例 | 取消/屏蔽过时结果，保留显式导出路径 | 小地图关、性能模式关分别覆盖 |

先R01确认缺陷；R02/R03中已有行为作为保护用例。不要直接从全局getSvgData删除forceLoadNode来让R01过关。

### T02 / I02：生命周期

**新增文件：** `tests/performance/editor-lifecycle.browser.cjs`。

| ID | 行为与断言 | 预期RED | GREEN最小变化 | REFACTOR/保护 |
|---|---|---|---|---|
| R04 | 同一Vue应用10次真实进入/退出；本组件两类bus监听恢复基准，其他监听保留 | 旧匿名回调累计 | 具名注册/对应解绑 | 不使用不带handler的$off(event) |
| R05 | 退出后发事件、推进两类保存计时器；旧实例保存/绘制/迟到应用均0，当前实例保存一次 | 旧闭包重新排保存 | 清计时器、generation、页面持有引用 | 清全局getCurrentData时核对所属实例 |
| R06 | 退出时仍在编辑/水合/断网，最后有效内容保存一次，已销毁DOM不复活 | 丢最后编辑或迟到任务访问旧引擎 | 按Plan顺序收尾并取消任务 | 数据、连接、历史、节点缓存释放；Heap另记 |

Heap以同轮次GC/空闲条件比较retained对象，使用带唯一标签的已销毁编辑器检查引用；不用一次总内存波动证明无泄漏。

### T03 / I09：外框资源

**新增文件：** `tests/performance/outerframe-lifecycle.browser.cjs`。

| ID | 行为与断言 | 预期RED | GREEN最小变化 | REFACTOR/保护 |
|---|---|---|---|---|
| R38 | 真实插件F个外框连续100轮渲染，保留文本引用与当前外框数量一致，DOM/group稳定 | textNodeList只push不清空，引用线性累计 | remove后清空当前数组 | 0外框和删除全部后引用/DOM为0 |
| R39 | 同一版本两个触发事件只提交一轮更新；文字/样式/范围变化最终正确 | 当前双事件可能重复重建 | 版本去重后按稳定外框身份复用 | 不截断活跃外框，不漏实际几何更新 |
| R40 | 点击/编辑/删除/撤销，以及折叠/移动/布局切换后框和文本位置正确，选中不指向退休元素 | 功能部分是保护用例 | 统一资源释放与几何刷新 | 真实DOM和实例引用均断言，不靠单次进程内存 |

### T05–T06 / I03：内容通知和历史

**新增文件：** `tests/performance/history-notifications.browser.cjs`；**更新既有断言：** `c2RendererCorrectness.browser.test.js` 的V2 editHistory。

| ID | 行为与断言 | 预期RED | GREEN最小变化 | REFACTOR/保护 |
|---|---|---|---|---|
| R07 | V2本地文字/样式/插入/删除/移动/粘贴实际生效；每个有效逻辑操作通知/协同提交，统计正确；3秒窗口内物理备份合并且最终内容落盘；增量通知链无整树复制/序列化，Count只处理受影响范围 | 当前复制树并全树统计；只停history会使通知保护失败 | 先独立通知/增量消费者，再停重复V2快照 | 不只测getCopyData=0；备份、导出与整树替换完整成本另计 |
| R08 | 展开/选中无内容撤销步，expand+text有；远端pause恢复后本地仍通知/保存；连续编辑写入数有界；房间A退出进入B后A草稿仍写A key，最终内容不丢 | 普通快照路径、错误停通知或过时key | 个人视图/内容边界、节流与捕获房间key | 断线outbox/刷新；大本地图现有写入边界单列 |
| R09 | 本地图back/forward正确；预算淘汰后可撤销范围明确；V2 Undo/Redo恢复父子顺序、墓碑、概要与附件 | 现有无字节预算；功能部分是保护用例 | V2走op-log，本地图有界历史 | 字节预算不等于Heap；至少保留当前有效状态 |

先写/跑通知、备份、可见撤销保护用例。禁止保留“V2 history.length增长才算编辑成功”的实现绑定断言，也禁止只断言提前return而不验证消费者。

### T04 / I05：索引和选择

**新增文件：** `tests/performance/uid-selection.browser.cjs`。

| ID | 行为与断言 | 预期RED | GREEN最小变化 | REFACTOR/保护 |
|---|---|---|---|---|
| R10 | 真实核心查询根/普通/概要/嵌套概要/不存在UID；查询不访问无关树分支 | 每次遍历树 | 当前实例UID索引 | 构建O(N)允许，查询不得重建 |
| R11 | 删除、折叠重开、远端水合、布局换代后不返回退休实例；M个缓存恢复仅M次索引读取 | 重复查树/可能旧实例 | 生命周期增删与换代维护 | 未渲染原始节点不能冒充实例 |
| R12 | 全选/框选集合正确且无重复；批次通知有界；右键单选不复活旧多选 | 激活列表逐个线性查重，通知放大 | 激活Set与聚合事件 | 概要子树、他人编辑限制和最后鼠标检测保持 |

方法spy必须call through真实findNodeByUid。不要在测试里先把它替换成Map查询，再声称生产查询已优化。

### T07 / I06：UID定向读

**新增文件：** `simple-mind-map/test/nodeUidRead.test.js`、`nodeUidRead.pg.test.js`。

| ID | 行为与断言 | 预期RED | GREEN最小变化 | REFACTOR/保护 |
|---|---|---|---|---|
| R13 | 请求M≤200按输入顺序返回，缺失/删除过滤，children完整按position,uid；业务字段/重字段契约与真值一致 | 旧DTO可能已正确，作为保护用例 | 复用查询能力但保持原DTO | 不直接用另一nodeQuery接口DTO替换 |
| R14 | 初始化V2图少量UID请求：全图snapshot/readRoomNodes/hash/Y.Doc调用=0；实际SQL范围受M/C/S约束 | 当前先读/hash整图 | 定向行/关系/计数查询 | C很大或准确root计数冷读另测 |
| R15 | REPEATABLE READ读到R后栅栏阻塞，另连接提交R+1，恢复后整份结果属于R；下一请求R+1 | 当前多查询可能混合版本 | 一致只读事务 | 验证ACL、房间删除、未初始化兼容与错误码 |

R15不能只检查执行了BEGIN；必须用真实并发连接观察revision、children和count属于同一版本。

### T08 / I06：计数与缓存

**新增文件：** `simple-mind-map/test/subtreeCounts.pg.test.js`。

| ID | 行为与断言 | 预期RED | GREEN最小变化 | REFACTOR/保护 |
|---|---|---|---|---|
| R16 | shallow/deep/安全预览的总孩子/后代与完整树真值一致；分页不以loaded长度计数 | 正确性部分是保护用例 | 所需parent聚合、目标子树精确计数 | 重叠请求范围合并，保留has_more/knownVersion |
| R17 | 固定revision第二次相同范围计数不重新枚举全图；LRU项数/字节受限 | 当前每次全图边读取 | 有界版本缓存 | 记录DB访问与Node接收边数，不靠SQL文本 |
| R18 | A写R+1、B旧缓存且通知丢失/无Socket，B读新值；A同revision修复原子推进PG共享generation后，B仍识别变化；旧在途结果不覆盖新键 | 只靠通知或进程内generation的设计失败 | 一致快照读PG revision＋持久化node_counts_generation再选缓存 | 版本0/未初始化绕缓存，未升级写者时全实例禁用；ACL撤销 |

缓存热读与冷root读分别报告。scope包括多个祖先时，独立真值检查不可简单把重叠子树相加。

T08包含拟议generation列的迁移。RED先用真实写者证明跨实例同revision变化可被识别；检查迁移、维修/导入/恢复写者清单、默认关闭的缓存开关与回滚顺序。不能用测试直接改DB后仅invalidate本实例来替代共享版本契约。

### T09 / I07：Direct写入与恢复

**新增文件：** `simple-mind-map/test/directHttpParity.pg.test.js`；**扩展：** `mcpIncremental.test.js`、`mcpRecoveryCompat*`、`mcpEventBridge*`。

| ID | 行为与断言 | 预期RED | GREEN最小变化 | REFACTOR/保护 |
|---|---|---|---|---|
| R19 | 已批准普通HTTP/MCP insert/update/delete走Direct；两路径规范化业务树、事件应用结果及各自逆操作恢复结果一致；无全图重建 | 默认普通HTTP走旧路径，MCP未启用或准入不足 | 显式身份/ACL准入与共享Direct事务 | nodes/rows逆操作格式允许不同，不deepEqual原始DTO；根/SOP/expected/LWW/UID/墓碑/顺序 |
| R20 | SQL中途失败节点/log/outbox全回滚；重复ID不产生第二版本；MCP同principal/digest重试返回原结果；ACK丢失不另写一次 | 可有保护用例，错误fallback实现应失败 | 原子事务与原ID重试 | HTTP保留现有旧结果返回语义；完整请求SQL与applier SQL分开 |
| R21 | unsupported shape在写前回legacy；403/409/SQL错误/提交后超时不回legacy；MCP同ID不同业务/身份拒绝 | 扩路由时防错误回退，基准部分已保护 | 分类准入，不catch业务错误换路径 | HTTP当前无通用digest冲突校验，本批不对HTTP作同body冲突拒绝承诺 |
| R22 | legacy删→Direct撤销，Direct删→legacy撤销；双实例op:event一次、丢通知补偿、版本缺口快照不提前推进水位 | 混合路径可能已有保护；新增事件覆盖需RED | 逆操作codec、桥/补偿一致性 | batch纳入前补batch.applied与冲突skip；当前先不纳入 |

功能矩阵：首批insert/非结构update/常规delete；move/reorder/keepChildren/batch/undo-redo扩大准入前逐项通过parity。明确全图导入/替换保留慢路径。不能凭一个新增节点Direct成功宣称所有操作均增量。

### T10 / I08：预览权限与SQL

**新增文件：** `simple-mind-map/test/cardPreview.pg.test.js`。

| ID | 行为与断言 | 预期RED | GREEN最小变化 | REFACTOR/保护 |
|---|---|---|---|---|
| R23 | 可信全房间上下文只验一次；直调engine仍验权；仅子树分享无全房间权限者冷/热缓存及不同share scope均拒绝；撤权/其他身份拒绝 | 当前完整房间授权重复查询；直接复用canView的错误修复会泄漏其他分支 | 匹配身份/room scope的授权复用和轻量meta | shareId提升权限不能用于全图预览；不接收query/body授权或缓存授权决定 |
| R24 | 最多根+6×(1+2)=19投影节点，顺序正确；宽一级树仍返回选中孩子的孙节点 | 旧CTE枚举全部且LIMIT40可挤掉孙节点 | 索引有界LATERAL/子查询 | deleted/空图/长文本；API sketch契约保持 |
| R25 | 同SQL快照revision与投影一致；浅宽1k/10k/30k记录真实buffers/访问行/耗时 | 当前分开meta/内容读或枚举工作量增长 | 单快照投影、正确索引使用 | LIMIT仅证明输出上限，不能替代EXPLAIN |

权限复用和去除用户状态查询后，静态owner路径预计约5条SQL；实际数量以真实追踪为准，暂不承诺1条。

### T11 / I08：预览队列与旧响应

**新增文件：** `web/tests/cardPreviewQueue.test.cjs`、`tests/performance/card-preview.browser.cjs`。

| ID | 行为与断言 | 预期RED | GREEN最小变化 | REFACTOR/保护 |
|---|---|---|---|---|
| R26 | 100任务最多4实际在途；同identity一次fetch；取消一个订阅不影响其他，最后取消才abort | 当前卡独立立即请求 | 共享队列、引用计数订阅与signal | 排队取消不能开始；不同revision不去重 |
| R27 | 同room R1慢、R2快，最终显示R2；不能把R1结果写入R2 cache；翻页/卸载旧响应无效 | 当前只比较roomKey并用最新key存旧结果 | 捕获identity/generation，按响应实际revision缓存 | 不同身份/session隔离，401/403/退出清理 |
| R28 | 真实卡片在观察区域（视口＋120px预取边界）之外不请求，进入才请求；卸载取消，失败可重试，LRU受限 | queue未接UI或旧结果仍应用；懒加载部分为既有保护 | service/card/queue完整接线 | 预取行为保留；懒加载/并发单独断言；Abort不缓存降级标题 |

可控deferred transport只用于边界调度；真实queue/service/RoomCard必须被执行，不能只验证模拟请求队列。

### T12 / I08：团队分页

**新增文件：** `simple-mind-map/test/teamRoomsPaging.pg.test.js`、`web/tests/teamRoomsPaging.test.cjs`；专项浏览器配置新增 `directory.spec.cjs`。

| ID | 行为与断言 | 预期RED | GREEN最小变化 | REFACTOR/保护 |
|---|---|---|---|---|
| R29 | F06遍历3页无重复/遗漏；过滤后、分页前total与独立真值一致；同名/时间稳定，角色/根/目录/搜索正确 | 当前全量返回无page | SQL分页过滤排序，room_key稳定次序 | title/createdAt/lastOpenedAt语义明确，不页内再排序 |
| R30 | 非成员/跨企业拒绝，team角色与room角色正确；删除/tombstone排除；limit/非法参数/末页空页处理 | 权限多为保护，分页新增用例RED | 服务端身份与分页DTO | DTO revision/content/resource更新时间准确 |
| R31 | FilesPage/SpaceDetail pager可达；SOP选第21张及后续、远程搜索和已有选项仍可见；取消旧搜索不覆盖新页 | 数组改DTO可能破坏3调用方/截断SOP | listRoomsPage新契约并完整迁移 | 翻页只读room页，目录缓存结构失效与计数 |

既有teamSpace fake DB可保护业务，但不能证明真实PG分页或索引计划；“realApi”服务测试仍有注入transport，不升级为live API证明。

### T13a–T13b / I04：视口、连线与布局

**新增文件：** `tests/performance/renderer-viewport.browser.cjs`、`tests/performance/layout-work-budget.browser.cjs`；专项 `renderer.spec.cjs`。

| ID | 行为与断言 | 预期RED | GREEN最小变化 | REFACTOR/保护 |
|---|---|---|---|---|
| R32 | F01相同V、N递增；视图改变工作量跟候选范围增长，平移缩放不doLayout | 当前root.render遍历全部展开节点/边 | 空间索引及进入/离开候选更新 | 模型保留，导出仍完整 |
| R33 | 穿越视口边含两端在外仍显示；离开清理，进入恢复，祖先折叠无幽灵边 | 原裁剪仅节点/新裁剪错误 | 保守边bounds/路由候选 | 曲线、跨层、概要、关联线另测 |
| R34 | 渲染换代/水合/销毁取消后旧帧不能复活group；无尺寸变化编辑不全图重测 | 当前遍历/重复任务成本 | generation与帧预算 | 富文本/公式/图片/标签/链接/resize |
| R35 | F02的实际坐标写入量随N线性，重复调整兄弟后代被捕获；小图golden与间距正确 | 宽多层重复移动呈二次方 | 两遍布局与子树位移量 | 不以重写toy布局当真值 |
| R36 | 尺寸变化只更新必要范围；无变化不移动无关分支，完整切换仍正确 | 当前每次完整布局 | 脏节点/祖先/兄弟范围 | 浮动customLeft/customTop、概要范围、紧凑路由 |
| R37 | 折叠/展开/插删/移动/粘贴/撤销/布局切换后节点与连线端点、选择、外框和导出正确 | 主要是保护用例 | 与新局部布局接合 | 未优化布局明确保留完整路径 |

旧 `collabLayoutGhost.test.js` 包含自行定义的局部算法，不能单独证明生产实现。复杂布局保持正确性优先，性能不达标不得通过关闭功能、删除节点、强制纯文本来变绿。

## 执行命令清单

以下是**确认后**的命令；当前新增文件尚不存在。仓库根目录执行。每轮先单一用例/文件RED，再同文件GREEN，最后只跑相关必要回归。

**拟新增测试入口：**

```sh
node tests/performance/fixture-contract.cjs
node tests/performance/minimap-lifecycle.browser.cjs
node tests/performance/editor-lifecycle.browser.cjs
node tests/performance/outerframe-lifecycle.browser.cjs
node tests/performance/uid-selection.browser.cjs
node tests/performance/history-notifications.browser.cjs
node simple-mind-map/test/nodeUidRead.test.js
node simple-mind-map/test/nodeUidRead.pg.test.js
node simple-mind-map/test/subtreeCounts.pg.test.js
node simple-mind-map/test/directHttpParity.pg.test.js
node simple-mind-map/test/cardPreview.pg.test.js
node web/tests/cardPreviewQueue.test.cjs
node tests/performance/card-preview.browser.cjs
node simple-mind-map/test/teamRoomsPaging.pg.test.js
node web/tests/teamRoomsPaging.test.cjs
node tests/performance/renderer-viewport.browser.cjs
node tests/performance/layout-work-budget.browser.cjs
node simple-mind-map/node_modules/@playwright/test/cli.js test --config simple-mind-map/e2e/performance/playwright.config.cjs --list
node simple-mind-map/node_modules/@playwright/test/cli.js test --config simple-mind-map/e2e/performance/playwright.config.cjs
```

上面PG/完整应用浏览器命令必须先通过隔离环境护栏。专项spec在T00创建并注册，`--list`必须包含预期测试而非0 tests。

**已存在的功能回归入口（按修改域选用）：**

```sh
node --test tests/personal-view-commands.test.cjs tests/layout-slices.test.cjs
node simple-mind-map/test/personalExpandCommands.test.js
node simple-mind-map/test/selectStaleCache.test.js
node simple-mind-map/test/selectGeneralizationSubtree.test.js
node simple-mind-map/test/collabLazySelection.test.js
node --test simple-mind-map/test/nodeSelectionContextmenu.test.js
node --test simple-mind-map/test/dragConnectorCleanup.test.js simple-mind-map/test/multiMoveGhostCleanup.test.js simple-mind-map/test/layoutDataBinding.test.js simple-mind-map/test/compactStructureRouting.test.js simple-mind-map/test/nodeResizeHandles.test.js
node simple-mind-map/test/roomNodes.test.js
node simple-mind-map/test/descendantCounts.test.js
node simple-mind-map/test/nodeDescendantCount.test.js
node simple-mind-map/test/nodeExpandCountRefresh.test.js
node simple-mind-map/test/nodeQuery.test.js
node simple-mind-map/test/mcpIncremental.test.js
node simple-mind-map/test/mcpRecoveryCompat.test.js
node simple-mind-map/test/mcpEventBridge.test.js
node simple-mind-map/test/collabV2.direct.test.js
node simple-mind-map/test/teamSpace.test.js
node simple-mind-map/test/roomAcl.test.js
node --test simple-mind-map/test/previewSketch.test.js
node web/tests/productShell.services.test.cjs
npm --prefix simple-mind-map run test:collab:files
npm --prefix simple-mind-map run test:collab:v2
npm --prefix simple-mind-map run test:collab:history
```

`mcpIncremental.test.js` 会启动临时MCP进程，不能称为纯函数单测；运行前同样核查进程的隔离环境。

**已存在的隔离PG/双实例/浏览器入口：**

```sh
node simple-mind-map/test/nodeQuery.pg.test.js
node simple-mind-map/test/mcpRecoveryCompat.pg.integration.test.js
node simple-mind-map/test/mcpEventBridge.twoInstance.integration.test.js
node simple-mind-map/test/safeLoad.partialChildren.p0.test.js
npm --prefix simple-mind-map run test:collab:history:pg
npm --prefix simple-mind-map run test:c2:renderer-correctness
npm --prefix simple-mind-map run test:c2:renderer-stable
npm --prefix tests/mcp-incremental run smoke
```

既有脚本安全前置各不相同，先核查并接统一护栏。不要在项目默认.env指向的环境直接运行这些脚本。13contexts完整性能矩阵由T14专项runner生成，不能用上述单一smoke结果代替。

## 验收与证据记录

| 类型 | 硬门槛/拟议目标 | 统计口径 |
|---|---|---|
| 小地图 | 稳态无周期自触发主图强绘；视图变化不重复整图导出 | 原方法call-through计数＋实际组件 |
| 生命周期 | 10轮退出后本组件监听回到基准，旧保存/迟到应用0 | 行为断言＋带标签Heap辅助 |
| 外框 | 100轮保留量等于当前外框；删除后0 | 实例引用与DOM双检查 |
| V2历史 | 普通增量通知链无整树复制/序列化/全树统计；通知、节流备份、撤销有效 | 整条链工作量与可见行为；完整备份/导出单列 |
| UID/多选 | 查询不遍历树，M个恢复M次索引；一次批次通知有界 | 真实关系访问/索引读取，不以耗时波动代替 |
| UID读取 | 初始化V2路径全图snapshot/hash/Y.Doc为0；版本一致 | 真实调用、PG并发栅栏与SQL |
| 计数 | 热同版本不重复全图计算，准确真值和跨实例更新 | 缓存命中、读revision与DB/Node工作量 |
| Direct | 准入parity、原子/幂等、事件/恢复完整，无隐藏整图读取 | 完整请求与applier开销分别记 |
| 预览 | 投影≤19节点、完整房间授权不复查、不查用户状态；子树分享不越权；并发≤4 | SQL实际计划＋UI实际在途请求 |
| 团队分页 | 页/过滤/total/稳定排序正确，全部3调用方可达 | PG与真实UI，权限矩阵 |
| 布局 | 适用宽树工作量线性，功能golden/端点正确 | 坐标/候选工作计数＋真实浏览器 |
| 相对性能 | 热单节点读/写P95较同环境基线下降≥40%；固定M/C/S时1k→10k倍率≤2；大图交互P95退化≤10% | **拟议目标待确认**；每组≥200样本、冷/热/布局/实例分别记 |

内存/缓存/帧预算见Plan，均为待确认建议。功能硬门槛与算法工作量先确认；相对性能基于本轮修改前基线，不能套旧文档510.55ms。若改进不足，保持任务未通过，依据trace调整；不得静默调低门槛。

每个用例/任务记录以下表，不把未运行的格子预填PASS：

| Task / Case | 基准SHA / 夹具 | RED命令、exit、实际断言 | 修复SHA / GREEN | 必要回归 | 性能样本与范围 | 状态 |
|---|---|---|---|---|---|---|
| T01 / R01 | 待执行 | 待观察 | 待实施 | 待执行 | 待采样 | NOT_RUN |

状态仅用NOT_RUN、RED_CONFIRMED、GREEN_CONFIRMED、BLOCKED_ENV、REGRESSION_FAILED、PERF_NOT_MET、ACCEPTED。ACCEPTED要求相关功能、回归和已约定性能门槛都有证据。缺实时op:event、缺DOM/视口延迟或13contexts未完成时分别记缺项，不能给整体E2E结论。

## 完成与用户确认

本TDD覆盖I01–I09，映射Plan的T00–T14。用户确认文档后，从T00收集/隔离与首批缺陷用例开始；生产代码必须在对应有效RED之后修改。当前停在文档确认点，不自动进入实施。
