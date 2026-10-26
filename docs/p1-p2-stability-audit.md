# P1 / P2 稳定性、回退与个人视图审计

- 日期：2026-10-23
- 范围：正式稳定性 / 性能回退 / 个人视图专项。不进入 P3 开发。
- 约束：保留 P1/P2 开关与回滚；不改生产配置；不覆盖既有未提交分析脚本；不改协同协议、修订号、ACK、节点数据格式。
- 代码：`03865ed` + 未提交 P1/P2（开关默认全关）
- 新脚本（未覆盖旧文件）：`tests/performance/p2b-first-render-repeat.browser.cjs`、`tests/performance/p1p2-compat-isolated.browser.cjs`、`simple-mind-map/test/userViewStateIsolation.test.js`、`web/tests/overviewExpandRestore.test.cjs`
- 原始数据：`output/p2b-first-render-repeat/results.json`、`output/p1p2-compat-isolated/results.json`

证据等级同架构报告：【源码】【实测】【未验证】【推断】。

---

## 1. 当前代码状态

六个 `performanceFlags` 默认 `false`。生产不带 `?perfFlags=` 时行为与改前相同。回滚路径：关开关或去掉 URL 参数。

本轮**没有**改个人视图持久化协议、没有改生产配置、没有改 P3 代码。

---

## 2. P2-B 6000 首屏回退：交错复测

上次单次对照里 P1+A/B 首屏 7199 ms、P1 4633 ms。本轮 8+8 交错（P1 / P1+A/B 轮流），同一页面、同一 6000 节点逻辑结构树。【实测】

| | P1 P50 | P1 P95 | P1+A/B P50 | P1+A/B P95 |
| --- | --- | --- | --- | --- |
| 墙钟 | 5369 ms | 6795 ms | 5113 ms | 5441 ms |
| getBBox | 42018 | 42018 | 36019 | 36019 |
| node.render 次数 | 6001 | 6001 | 14 | 14 |
| DOM 新增 | 6009 | 6009 | 118 | 118 |

阶段耗时 P50（包装后的墙钟，含切片让出）：

| 阶段 | P1 | P1+A/B |
| --- | --- | --- |
| 布局 | 8.2 ms | 8.2 ms |
| 视口索引 | 60.7 ms | 35.8 ms |
| paintViewport | 24.3 ms | 0.8 ms |
| node.render 合计 | 163.3 ms | 12.8 ms |

结束后挂载：两组都是 1 个节点组 / 15 条 path / 模型 6000。默认视口几乎只看根，P2-B 少做了大量视口外 `render` 和 DOM 增删。

**结论：上次 6000 首屏变慢是环境波动，不是稳定回退。** P50 比 0.95，P2-B 略快。墙钟单次可从 3.9 s 到 8.7 s，单次对比不可信。

---

## 3. 隔离环境兼容性（P1+P2-A/B）

合成树，无生产房间。开关 `off` 与 `p1ab` 对照。【实测】

| 项 | 结果 |
| --- | --- |
| 逻辑结构几何 | 0 处 >1px；expand 图相同 |
| 9 种布局首屏 | 均成功，节点数 5，特性字段在 |
| 备注 / 评论 / 超链接 / 附件 | 节点数据字段在；**未点 UI 打开面板** |
| 小地图 | 有 SVG，宽 457，开关一致 |
| 关联线 | `ADD_ASSOCIATIVE_LINE` 后目标 uid 正确 |
| 搜索定位 | 能找到折叠分支里的节点 |
| SVG / PNG / PDF / XMind | 均产出字节；开关开/关 SVG 21118、PNG 52174、PDF 30437、XMind 10816 **完全一致** |
| 撤销重做 | `BACK` 回到原文，`FORWARD` 回到改文 |

**未能实际测试（不能声称通过）：**

- `verticalTimeline2/3`、`fishbone2`、左右鱼骨、`compactLayout`
- 备注/评论/超链接/附件的点击、预览、下载
- 富文本编辑、外框、演示模式、彩虹线
- 真机打印、移动端、带图片节点的导出
- 真实房间里的搜索/定位/懒加载水合
- 多人同时撤销

搜索定位会触发 `personal_expand_change`（见第 4 节），开关开/关都如此，不是 P2 引入。

---

## 4. 个人展开专项

### 4.1 本轮测到的

| 场景 | 结果 | 等级 |
| --- | --- | --- |
| 折叠后平移卸/挂 DOM | expand 不变 | 浏览器【实测】（上一轮 + 本轮兼容树） |
| 远端字段带 expand | 本地不改 | 浏览器【实测】 |
| 用户 A/B、房间 A/B 隔离 | 内存文件系统按 `(room, user)` 分开 | `userViewStateIsolation`【实测】 |
| 服务端只 PATCH expand | 保留 layout/theme；**整个 expand 对象被替换**（不是按 uid 深合并） | 同上【实测】 |
| 大图概览收深层后再 apply 偏好 | 能把被 stub 收起的节点按偏好展开 | `overviewExpandRestore`【实测】 |
| 开关开/关 | 展开结果一致 | 【实测】 |
| 搜索定位 | 会展开祖先并 **发出 `personal_expand_change`**，绑定后会写入偏好 | 浏览器【实测】 |

### 4.2 未能上真实房间的

| 场景 | 原因 |
| --- | --- |
| F5 后恢复 | 需要完整 Edit 页 + 已登录房间 |
| 退出房间再进入 | 需要路由 + `unbind/bind` 真走一遍网络 |
| A/B 两个真人会话 | 需要两个登录身份 |
| A→B→A 房间切换 UI | 存储键与 unbind 源码在；完整 `$route` 未跑 |
| 懒加载后恢复 | 恢复循环源码在；未接 `httpFetchSubtree` |
| 服务端 view-state 与 localStorage 冲突的线上时序 | 只验证了源码规则和内存存储 |

### 4.3 读写入口与权威来源（只读梳理，不改协议）

**展开**

| 方向 | 入口 | 写什么 |
| --- | --- | --- |
| 读 | `loadPersonalExpandState(room, user)` | localStorage `mind-map-personal-expand:v1:user:room` |
| 读 | `getPersonalViewState(room)` | `GET /api/files/:room/view-state` → `state.expand` |
| 写 | `afterExecCommand`：`SET_NODE_EXPAND` / `SET_NODE_DATA.expand` / 批量展开收起 | 内存 map + localStorage + 350ms 后 PATCH `{expand}` |
| 写 | `personal_expand_change` → `collectPersonalExpandState` | 把当前 `renderTree` 全部 uid 合并进 map |
| 写 | `unbindPersonalExpandState` | 离开房间再存一次 |
| 应用到树 | `applyPersonalExpandState` | 只改 `renderTree.data.expand`；保护 uid 只挡收起 |
| 树侧临时写 | `expandToNodeUid`、`ensureHttpNodePath`/`expandTreeNode`、`repairEmptyExpand`、`expandAll`/`unexpandAll`、大图 `stubImportedTree` | 直接改树上 expand；前几项还会 `personal_expand_change` |

**外观（主题/布局）**

| 方向 | 入口 |
| --- | --- |
| 读/写 | `bindPersonalAppearance`：localStorage `mind-map-personal-appearance:v1:user:room` + 同一 view-state 的 theme/layout/themeConfig |
| 写 | `view_theme_change` / `layout_change` 等，350ms PATCH（不含 expand） |
| 读 | 每次 `node_tree_render_end` 尝试 restore |

**服务端**

- 表：`room_user_state(room_key, user_id).view_state`
- PATCH 对 `view_state` 做 **对象浅合并**（`prev || patch`）。`expand` 是其中一个键，**整张 expand 图被替换**。
- 鉴权：当前登录用户，只读写自己的行。

**冲突规则（当前实现）**

1. 会话内本地已脏（`locallyChanged` / appearance `dirty`）：迟到的 GET **丢弃**，本地赢。
2. 会话内未脏：`{...localStorage, ...remote}`，**远端按 uid 覆盖**。
3. 同用户多标签：后一次 PATCH 赢；后打开且未编辑的标签会被 GET 拉回服务端。
4. 用户之间、房间之间：键和表都隔离。
5. 协同树不是权威：入站删除 `expand`；展开命令不进内容历史。

**权威来源（建议写进修复设计，现网实际是混合的）**

- 会话进行中：内存 `personalExpandState`（本地已脏时）。
- 冷启动未脏：服务端 view-state，其次 localStorage。
- 画布展示：`renderTree.data.expand`，可被概览 stub、定位、水合临时改写，再靠 restore 拉回。

### 4.4 潜在缺陷与修复设计（不改现网协议）

协议保持：`GET/PATCH /view-state`、`{expand, theme, layout, themeConfig}`、按用户行存储。先改客户端语义。

| 优先级 | 缺陷 | 设计 |
| --- | --- | --- |
| P0 | **搜索/定位/`revealUid` 会 `personal_expand_change`，把导航展开写进偏好。** 注释写明「先存再 render，以免 restore 收回去」。结果是搜一次就永久展开祖先。 | 增加「会话揭示」层：`expandToNodeUid` 只改树、设 `protectUids`，**不 emit persist**。`unbind`/F5 仍用未污染的偏好。可选：搜索结束再收起揭示过的祖先。不改 PATCH 字段。 |
| P1 | 大图 stub 先改树上 expand；restore 失败则比偏好更收。 | 概览用影子树或 `overviewCollapse` 标记，不要覆盖权威 map。揭开后只 `apply(权威 map)`。协议不变。 |
| P1 | 未脏时远端 GET 按 uid 覆盖 localStorage。多标签会丢未上报的点击。 | 带 `updatedAt` 的乐观合并：只接受更新的远端；或打开房间时若本地时间更新则先 PATCH。可加字段，旧服务忽略。 |
| P2 | `collect` 记下整棵当前树，含远端新插入的折叠 uid。 | collect 只更新用户碰过的 uid；新 uid 缺省不写。仍发同一 `{expand}` 形状。 |
| P2 | 定位/概要水合 `expandTreeNode` 强制祖先展开。 | 与 P0 同一「揭示 vs 偏好」分层。 |
| P3 | 外观每次 `node_tree_render_end` restore。 | 只在 bind 后或 layout/theme 命令后 restore。 |
| 记录 | 服务端 expand 整对象替换。 | 客户端继续传全量 map 即可。若以后要深合并，属于协议扩展，本轮不做。 |
| 记录 | 远端新节点本地 `expand: false`。 | 保持；这是插入策略，不是偏好 bug。 |

---

## 5. P3 局部布局：最小方案（本轮不改代码）

目标：改字/插入/删除/展开时不要 `doLayout` 整棵已展开树。开关 `partialLayout.logicalStructure`，默认关；失败回退全量。

**脏集**

- 本地：`SET_NODE_TEXT` / 插入删除 / `SET_NODE_EXPAND` 把 uid 放进 `renderer._dirtyUids`。
- 远端：已有 `planRemoteNodePaint`；尺寸变或结构变才进脏集。样式-only 不进。
- 个人展开：脏的是本地可见性，不是协同内容。

**布局依赖（先只做 `logicalStructure`）**

当前三步：`computedBaseValue`（量尺寸、算 left）→ `computedTopValue`（垂直分配）→ `adjustTopValue`（兄弟平移）。【源码】

`relayout(dirtyRoots)`：

1. 从脏节点量尺寸。
2. 沿祖先重算 `childrenAreaHeight`。
3. 只平移受影响的后续兄弟子树（已有两遍平移可复用）。
4. 返回 `{moved}`。其它布局返回 `null` → 全量。

**索引**

- 有 `moved` 才能增量更新视口索引（原 P2-C）。
- 无脏集时增量索引仍要扫全树，本轮继续不做。

**影子校验**

- `?perfFlags=partialLayout,shadowLayout`：同一帧全量再算一遍，坐标差 > 0.5px 则记录并采用全量。
- 灰度必须开影子；稳定后再关。

**不做**

- 改协议 / revision / ACK / `expand` 持久化。
- 思维导图、组织图跟进（P3-4）。
- Worker 布局。

---

## 6. 灰度条件

**P1 可以灰度。** 默认关；打开后首屏和远端样式误伤有数，样本文本导出一致。

**P2-A 可以灰度。** 连线 `getBBox` 次数稳定下降；失败回退 `getBBox`。

**P2-B 可以小范围灰度。** 6000 首屏回退不成立；空载/改字有收益；挂载组数不变。建议：测试房间先开 `p1+p1a+p1b`，看小地图/导出/搜索。不要一次开全员。

**个人视图代码缺陷（搜索写偏好、概览覆盖、迟到 GET）已在第 7 节修复。** 真实房间 5 条仍未测，故个人视图还不能声称生产已验收。

### 阻止项与优先级

| 优先级 | 是否挡住性能灰度 | 问题 |
| --- | --- | --- |
| 已修 | 否 | 搜索/定位写入个人偏好；概览 stub 落盘；迟到 GET 盖本地。 |
| P0 | 否 | 真实房间 F5、进出、A/B、切房、懒加载、概览进出未测。 |
| — | 已排除 | 6000 节点 P2-B 首屏回退：交错复测为波动。 |
| 本轮不做 | — | P3 局部布局。仍是每次操作的主成本。 |

**结论：** 可以在测试房间打开 P1 + P2-A/B 做性能灰度；生产配置保持全关。搜索写偏好已修。个人视图生产验收仍差真实房间回归。

---

## 7. 个人视图正确性修复（2026-10-23，本轮）

未改 persist 字段形状 `{expand, theme, layout, themeConfig}`。未改 P1/P2 开关默认。未做 P3。

### 读写调用链

```
用户点击展开/折叠
  → SET_NODE_EXPAND / SET_NODE_DATA{expand}
  → afterExecCommand → persist 内存 + localStorage + 350ms PATCH {expand}

用户批量展开/收起
  → EXPAND_ALL / UNEXPAND_ALL / UNEXPAND_TO_LEVEL
  → personal_expand_change(无 source 或 user) → collect 当前树 → persist

搜索 / GO_TARGET_NODE / revealUid
  → expandToNodeUid / ensureHttpNodePath
  → 临时改 renderTree.data.expand
  → personal_expand_change({source:'reveal'}) → 不 persist
  → 下次 restore 用权威偏好收回（激活路径仍受 protectUids 保护）

大图概览
  → 冻结 persist，快照进入前的 personalExpandState
  → stubImportedTree 只改画布树
  → 退出/失败：写回快照再 restore；unbind 若仍冻结则保存快照而不是树上的临时折叠

远端节点字段
  → applyHttpRemoteNodeFields 删除 expand

冷启动
  → load localStorage
  → GET view-state；仅当同房间、同 fetchId、且本会话未脏时 merge
  → apply + hydrateExpandedPartialParents({render:false})
```

### 权威与冲突

| 情况 | 谁赢 |
| --- | --- |
| 本会话已有用户展开操作 | 内存偏好；迟到 GET 丢弃（fetchId + locallyChanged） |
| 本会话未脏的 GET | `{...local, ...remote}`，远端按 uid 覆盖 |
| 概览期间 | 不 persist 树；退出用进入前快照 |
| 搜索揭示 | 只改画布，不改权威偏好 |
| 用户在搜索中手动展开/折叠 | afterExecCommand 仍 persist |
| 多标签 | 同浏览器共享 localStorage；未加服务端时间戳。跨设备仍是后一次成功 PATCH。协议未改。 |

未引入 `updatedAt` 到 PATCH 体，避免未评审改接口。

### 已修旧问题

| 问题 | 状态 |
| --- | --- |
| 搜索/定位 `personal_expand_change` 写入偏好 | 已修：`source:'reveal'` 不 persist |
| 概览 stub 折叠被存成偏好 | 已修：冻结 + 快照；失败/unbind 不存 stub |
| 迟到 GET 盖住较新本地操作 | 已修：fetchId + locallyChanged；外观 GET 同样 |

### 实测 / 未测

**实测（隔离）：** 搜索只发 reveal、不用用户命令；随后手动折叠走 `SET_NODE_DATA`；远端不改 expand；开关 off / P1+A/B 一致。策略单测、会话模拟（F5 迟到 GET、切房间键、概览失败不存 stub）、用户/房间隔离、概览 apply。

**未测（真实房间）：** F5、退出再进、两个登录用户、A→B→A 路由、真懒加载水合、多标签真机、概览进出真房间。需要测试房登录后补。

### 对 P1/P2 灰度

性能开关未改，默认仍关。搜索揭示与偏好分离不碰绘制/协议/导出。测试房仍可开 P1+P2-A/B。

**生产灰度：** 性能开关可以继续在测试房开。个人视图正确性见第 8 节真实房间验收。

---

## 8. 真实测试房间集成验收（2026-10-23）

未部署、未改生产配置、未新建账号、未写业务房间节点。前端为当前源码 `http://127.0.0.1:8989`（补了 `en_us.js` 一处缺逗号才能编译），API 为本机 Docker `http://127.0.0.1:8990`。登录：已有 `AUTH_DEV_BYPASS` → 用户 `yangxiaodong`。房间：既有 C2 / p0 隔离房。

数据：`output/real-room-acceptance/results.json`、`hydrate-probe.json`。

### 证据等级

| 项 | 等级 | 结果 |
| --- | --- | --- |
| 1 F5 恢复上次展开 | 真实浏览器+服务端 E2E | 通过。`c2-profile-1000-1788764665084` 展开 `n0` 后刷新，树 / 偏好 / `GET view-state` 均为 `true` |
| 2 退出再进 | 真实 E2E | 通过。`/files` 再进同房，`n0` 仍为上次状态 |
| 3 用户 A/B 互不影响 | 未验证 | 只有一个已授权登录。未冒充、未新建账号 |
| 4 A→B→A 切房 | 真实 E2E | 通过。B 房改展开后回 A，A 的 `n0` 偏好未串 |
| 5 懒加载水合 | 真实 E2E（部分） | `c2-browser-5000` 服务端 5000 节点；首屏 renderTree=2；展开 `n0` 后 10 节点、8 个子节点。未插远端节点（避免改共享 C2 树） |
| 6 搜索不污染偏好 | 真实 E2E（弱） | 搜 `Node 1` 未发出 persist 事件，服务端 expand 未变。随后用户折叠 `n0` 写入偏好。未观察到 `source:'reveal'` 事件（搜索可能未命中深层） |
| 7 大图概览进出 | 未观察到概览相位 | 连接完成时 `largeMapInitialOverview` 已是 false；未拍到进入中的冻结态 |
| 8 迟到 GET / 快切房间 | 真实 E2E | 延迟 2.5s 的 GET 未盖住打开后的手动展开。快切后落在房间 A |
| 8 断线重连 | 未验证 | 未杀 Docker / 网络 |
| 9 双标签 | 真实 E2E | 同域 localStorage 共享；内存偏好可分叉（tab1 `true` / tab2 `false`）；服务端为后一次 PATCH（`false`） |
| 10 开关开/关功能 | 真实 E2E（部分） | 展开/改字/画布 SVG 两边都能跑。导出 API 未接到（`doExport` 不存在）。附件/关联线/小地图面板未点。可见节点数随水合变化，字节对比无效 |
| 3000/6000/10000 整树帧时 | 隔离浏览器合成（既有） | 见下。真实房间本次只测到懒加载后的 2–10 个可见节点，不能当成整树 10000 的 P50/P95 |

### 真实房间里测到的性能（懒加载可见节点，不是整树）

环境：Playwright Chromium headless，Windows，Vue 开发服 8989 + Docker API 8990。服务端规模 1000/5000/10000，首屏常见 2 个节点。

| 房间规模（服务端） | 开关 | 展开 P50/P95 ms | 改字 P50/P95 ms | 打开墙钟 ms | 可见节点 |
| --- | --- | --- | --- | --- | --- |
| 1000 | 关 | 6.7 / 109 | 2.7 / 8.9 | 1551 | 2 |
| 1000 | P1+A/B | 5.0 / 53 | 1.6 / 4.3 | 1719 | 2 |
| 5000 | 关 | 2.8 / 129 | 3.1 / 5.2 | 1508 | 2 |
| 5000 | P1+A/B | 2.6 / 82 | 4.3 / 6.5 | 1562 | 2 |
| 10000 | 关 | 4.8 / 128 | 3.4 / 11.5 | 1872 | 2 |
| 10000 | P1+A/B | 18.5 / 291 | 4.5 / 20.2 | 1580 | 2 |

连续远端更新、拖动帧时：本轮真实房间未测。

### 隔离合成整树（上次，不能写成真实房间通过）

`output/p2-optimizations/p2-results.json`。模型节点 3000/6000/10000。

| n | 开关 | 空载墙钟 ms | 改字墙钟 ms |
| --- | --- | --- | --- |
| 3000 | 关 | 154 | 132 |
| 3000 | P1+A/B | 85 | 57 |
| 6000 | P1 | 306 | 211 |
| 6000 | P1+A/B | 202 | 194 |
| 10000 | P1 | 442 | 496 |
| 10000 | P1+A/B | 190 | 177 |

单元测试：`web/tests/personalViewPolicy.test.cjs` 等，本轮未重跑。

### 结论

- **性能开关：** P1 + P2-A/B 仍具备测试房小范围灰度条件。生产保持全关。本轮真实房间没有否定该结论。
- **个人视图已真正验收：** 同用户下 F5、退出再进、A→B→A、迟到 GET、快切房间、双标签实际冲突、用户折叠写入、5000 房懒加载展开水合。
- **未验收 / 阻断：** 没有第二个登录身份，A/B 两人不能声称通过。概览相位未拍到。未插远端节点。未做真断线。导出/附件/关联线/小地图 UI 未完整点。这些**不阻断**性能开关测试房灰度。
- **主性能瓶颈：** 仍是每次操作全量 `doLayout`（P3）。真实大房首屏走懒加载/stub，可见节点很少；整树成本仍以隔离数据为准。
- **P3：** 有性能必要，本轮不启动。

停止。不部署、不提交、不进入 P2-C/P3。
