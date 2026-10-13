# 多人协同与 MCP 写入性能诊断

诊断日期：2026-10-12。本轮只读本地代码，没有改协同协议、数据库结构、Outbox、权限、导入导出或撤销重做，也没有新增埋点。

本文所有结论都来自当前仓库函数调用关系。没有在 6000 节点房间、1 人 / 10～15 人、MCP 关闭 / 空闲 / 持续写入这几组条件下采集耗时。因此下面的「耗时」列全部是未实测。LCP 53 秒对应哪个阶段，同样没有浏览器分段录制，不能把它当成布局耗时。

## 1. 结论（代码已证实 / 尚未计时）

**已证实的结构性第一瓶颈：** AI 的 `add_node` / `update_node` / `delete_node` 不进入 collabV2 Sequencer。每次单节点写入先做一次整图快照读取，再在 `rooms` 行锁事务里把全部节点读进内存、装进临时 Y.Doc、再整图规范化。6000 节点时，锁持有时间随整图规模增长，而不是随「改了 1 个节点」增长。

**这不是「SQL 条数特别多」。** 单次插入的 SQL 条数和 Sequencer 直写大致同级（约 8～12 条）。差别是其中两条把全部活节点和全部墓碑读出来，事务在规范化 6000 节点期间不提交，并且 `SELECT ... FOR UPDATE` 锁的是用户协同也要锁的同一行 `rooms`。

**已证实的放大因素：**

1. MCP 工具一次只提交一个节点，没有复用 `batch.apply`。Agent 循环调用就会串行堆叠整图事务。
2. 默认 `COLLAB_V2` 开启时，这条 HTTP 提交**不会** `emit('op:event')`。浏览器不会在每次 MCP 写入时立刻布局。
3. 其他客户端之后若收到一条版本号跳过这些 MCP 操作的 `op:event`，会走 Gap Sync，把漏掉的操作逐条应用。插入应用会把父节点设为展开并调用 `mindMap.render()`。
4. 发起该操作的客户端自己的 ACK 会把 `lastServerRevision` 直接抬到返回版本，中间的 MCP 操作不会被这条 ACK 应用。

**尚未证实：** 展开/收起变慢的主体究竟是 Gap Sync 之后的主线程布局、子树水合请求在连接池上排队，还是仅仅因为用户操作的 ACK 堵在同一行锁后面。这三件事都和上述路径相容，但没有计时，不能排序。

## 2. MCP 是否复用 Sequencer

不复用。两条写入路径并存。

| 来源 | 入口 | 提交函数 | 节点写入 |
| --- | --- | --- | --- |
| 浏览器协同 | `socket.on('op')` | `collabV2/sequencer.js` `submitOperation` | `commitDirectRoomOperation`，按节点 SQL |
| MCP `add_node` / `update_node` / `delete_node` | HTTP `/api/files/:room/nodes` | `mindApi.js` `executeOperation` → `executeTrustedOperation` | `commitRoomOperation`，整图快照事务 |

Sequencer 只被两处调用：`bin/collabV2/socketServer.js` 的 `op` / `sync`，以及 `bin/mindApi.js` 里独立的 V2 HTTP 操作接口（约 1638–1671 行）。MCP 工具打的是 `/nodes`，不走该接口。

`COLLAB_V2` 默认开启（`bin/collabV2/flag.js` 第 7–8 行，缺省为 true）。开启后，Outbox 发布器把 Yjs awareness 扇出关掉（`bin/collabServer.js` 第 327–330 行，`onEvent: false`）。全仓库只有 `socketServer.js` 第 311 行会 `socket.to(roomName).emit('op:event', op)`，且只发生在 Sequencer 的 `op` 处理里。MCP 的 HTTP 提交到不了这里。

## 3. `add_node` 调用链

### 3.1 MCP 进程

`bin/mcpServer.mjs`

- 第 30–33 行：进程级 `MCP_CLIENT_ID`，满足 V2 `requireClientId`。
- 第 175–198 行 `writeMap`：先 `GET /api/files/:room?format=meta` 取 `baseVersion`，再带 `baseVersion` 调用业务接口。
- 第 925–954 行 `add_node`：`POST /api/files/:room/nodes`，body 只有 `text`、`parent`、`note`、`confirm_sop_change`。一次工具调用对应一个节点。

`update_node`（962–985）、`delete_node`（993–1014）、`rename_map`（1050–1066）同样经 `writeMap`。`replace_tree`（1022–1042）走 `POST /replace`。

### 3.2 修订号预读已经是整图读

`GET ?format=meta` 在 `bin/mindApi.js` 第 3470–3487 行先 `loadMap`，再在 `mapPayload` 第 991 行丢掉正文、只返回 meta。

`loadMap`（838–845 行）在 V2 下调用 `getRoomSnapshot`。`bin/storage.js` `getRoomSnapshot`（1414–1520 行）做：

1. `SELECT room_key, title, nodes, version, updated_at, metadata FROM rooms`（含 `nodes` jsonb）。
2. `readRoomNodes`：`SELECT` 该房间全部 `deleted_at IS NULL` 的 `room_nodes`（`bin/roomNodes.js` 679–697 行）。
3. `describeTreeAuthority`（317–332 行）对表图和 JSON 图各做一次 `canonicalTreeHash`。哈希实现（299–314 行）会 `validateNodeGraph`、`encodeNodeRows`、按 uid 排序后对整图做 SHA-256。

这一步没有 `FOR UPDATE`，也不广播。它发生在真正写入之前，每个 MCP 写节点至少两次整图读取（这次预读，加上下一节事务内再读一次）。

### 3.3 HTTP 节点接口

`bin/mindApi.js` 第 2673–2686 行：`POST /nodes` → `normalizeCommand(..., 'node.insert')` → `executeOperation`。

`executeOperation`（417–425 行）先 `assertRoomAccess(..., 'edit')`，再 `executeTrustedOperation`。

`executeTrustedOperation`（340–385 行）调用 `commitRoomOperation`，回调里：

1. 用当前整图 `mindDoc.applyObjectToDoc(tempDoc, base, { replace: true })`。
2. `applyNodeCommand`。
3. `mindDoc.readObject(tempDoc)` 把整图交回去。

这里没有 `sequencer.submitOperation`，也没有 `commitDirectRoomOperation`。

`withRoomMutation`（196–208 行） additionally 用进程内 Promise 队列把同一房间的 HTTP 变更串行化。浏览器 Socket 写入不进这个队列，但会在数据库行锁上和它相遇。

### 3.4 事务与行锁

`bin/storage.js` `commitRoomOperationOnce`（2075–2293 行），一个事务：

| 顺序 | 语句 | 范围 |
| --- | --- | --- |
| 1 | `BEGIN` | |
| 2 | `SELECT ... nodes, version ... FROM rooms WHERE room_key=$1 FOR UPDATE` | 锁整房间行，并取出 `nodes` jsonb |
| 3 | `SELECT ... FROM room_operations WHERE room_key=$1 AND operation_id=$2` | 幂等 |
| 4 | `readRoomNodes` | 全部活节点 |
| 5 | `listDeletedNodeUids` | 全部墓碑 uid |
| 6 | 内存：临时 Y.Doc 装入整图，`applyNodeCommand`，`readObject` | 全部节点，仍占着未提交事务 |
| 7 | `snapshotCanonicalForStorage` → `canonicalizeNodes` | 校验、编码、再解码整图（`roomNodes.js` 359–392 行） |
| 8 | `writeRoomNodeRows` / `replaceRoomNodes` | 见下节 |
| 9 | `UPDATE rooms SET nodes, version, title, updated_at` | 每次都写 |
| 10 | `INSERT INTO room_operations` | 1 行 |
| 11 | `INSERT INTO room_outbox` | 1 行 |
| 12 | 版本为 1 或被 `COLLAB_SNAPSHOT_EVERY`（默认 100）整除时 `INSERT room_snapshots` | 整图 jsonb |
| 13 | `SELECT pg_notify('collab_events', ...)` | 只带 mapId、version、operationId |
| 14 | `COMMIT` | 行锁在此释放 |

`node.insert` 在 `bin/roomCommands.js` `applyNodeCommand`（136–177 行）里还会 `mindDoc.readObject` 一次，`stampPositions`（62–76 行）再 `readObject` 一次。`addNodeOnDoc`（`bin/mindDoc.js` 805–844 行）本身只改父节点和子节点，但外层已经把整图装进了 Y.Doc。

增量写条件在 `storage.js` 2170–2183 行：未 `reindex`、类型是 update/move/reorder/insert、`affectedUids` 在 1～20 个。满足时 `replaceRoomNodes`（545–625 行）只 upsert 这些 uid。不满足时（兄弟位置重排会把 `payload.reindex` 设为 true，`fractionalIndex.js` `insertPositionAt` 170–206 行）改为写出编码后的全部行，并把不在列表中的活节点打上墓碑。重排因此会把单节点插入放大成整表写。

`rooms.nodes` 的 jsonb：当 `COLLAB_NODES_AUTHORITY !== 'json'` 且双写开启且节点数 ≥ `LARGE_MAP_NODES`（`storage.js` 第 157 行，400）时，第 2186–2191 行只写入 `{ root: snapshot.root }`。这避免把 6000 节点 JSON 再写回 `rooms`，但第 2 步的 `SELECT ... nodes`、第 4 步的全表读和第 6–7 步的整图规范化仍然发生。

提交后、锁外：

- `applyCommittedLive`（`mindApi.js` 291–333 行）若内存里已有 live Y.Doc，会再应用一次；大图的 `map.replace` / `batch.apply` 会 `dropLiveDoc`。
- `nodeMutationResponse`（793–800 行）再 `getRoom`。
- `operationEvents.emit('committed')`（`storage.js` 2309 行附近）触发 `collabHistory` `onCommitted`（`bin/collabHistory/engine.js` 1069 行）。检查点间隔默认 200（`config.js` `HISTORY_CHECKPOINT_EVERY`）。
- Outbox `kick` 再开一个事务认领 outbox，并再 `pg_notify` 一次（`bin/outbox.js` `flushOutbox`；`bin/eventBus.js` `publish` 73–87 行）。V2 下这个发布不转成浏览器 `op:event`。

### 3.5 对照：浏览器单节点插入

`bin/collabV2/socketServer.js` 260–311 行 → `sequencer.submitOperation`（42–128 行）→ `isDirectType` → `commitDirectRoomOperationOnce`（`storage.js` 1919–2054 行）。

该事务的 `SELECT rooms ... FOR UPDATE` **不读 `nodes` 列**。`directApplier.applyInsert`（208–270 行）通过 `directStore` 做父节点、祖先、同级和单行 `INSERT`，不装整图。成功后才 `socket.to(...).emit('op:event')`。

两条路径锁的是同一行 `rooms`。MCP 整图事务未提交时，浏览器 Sequencer 的 `FOR UPDATE` 会等这把锁。展开/收起本身不写这行，见第 6 节。

## 4. 每个 MCP 写节点的事务、SQL 和广播

以下是 `add_node` / `update_node` 的静态清单，不是耗时。

| 项目 | 次数 |
| --- | --- |
| HTTP 请求 | 2（meta + 变更） |
| 数据库事务 | meta 为自动提交读；变更 1 个显式事务；Outbox flush 另 1 个事务 |
| meta 阶段 SQL | 2（`rooms` 一行 + 全部活 `room_nodes`）+ 两次整图哈希 |
| 变更事务 SQL | 固定约 8～11 条；其中 2 条扫描全房间节点/墓碑。重排或 `affectedUids > 20` 时节点写变成整表 upsert + 墓碑 |
| `room_operations` | 1 行 |
| `room_outbox` | 1 行 |
| `pg_notify` | 提交时 1 次，Outbox 发布时再 1 次 |
| Socket `op:event` | 0 |
| 历史任务 | 每次提交入队 1 次；每 200 个操作可能再写检查点 |

`upload_attachment`（`bin/mcpAttachmentUpload.mjs` 约 369–449 行）先上传文件，再用 `PATCH /nodes/:uid` 挂字段，挂载重试最多 3 次。每次 PATCH 都是上面的整图事务。`delete_attachment` 同样落到 `node.update`（`mindApi.js` `detachNodeAttachment` 476–518 行）。

`complete_todo`、`apply_sop_improvement`、`replace_tree` 不是「一节点一事务」，而是一次 `executeSnapshotOperation`（734–767 行），把整棵 `nextNodes` 交给 `commitRoomOperation`。事件类型是 `batch.applied` 或 `map.replaced`，并带 `resnapshot: true`。

`bin/mindApi.js` 2603–2617 行的输入规则保存会按条循环 `node.insert`。那不是 MCP `add_node`，但如果 Agent 自己循环调用 `add_node`，效果相同：N 个节点 = N 次整图事务。MCP server 没有把多个 `add_node` 合成 `batch.apply`。

## 5. 折叠节点、布局和版本追赶

### 5.1 服务端不看展开状态

`commitRoomOperationOnce` 和 `applyNodeCommand` 都没有读取 `expand`。写到已折叠节点时，仍然读取并规范化全部 6000 节点。`addNodeOnDoc` 把新节点的 `expand` 设为 `true`（`mindDoc.js` 817–820 行），这是数据字段，不是「只更新可见节点」。

### 5.2 浏览器布局默认跳过折叠子节点

`Render._render`（`src/core/render/Render.js` 704–745 行）调用 `layout.doLayout`。逻辑结构布局在子节点 `expand` 为 false 时不再往下排（`src/layouts/LogicalStructure.js` 第 70 行附近；`Base.js` 第 461 行用同样条件计算子节点数）。仅展开约 145 个节点时，单次布局遍历的是可见树，不是 6000 个 SVG。

这个优化只对已经在渲染树上、且保持折叠的节点成立。

### 5.3 远程插入会强制展开并渲染

`Cooperate.applyV2PayloadInsert`（`src/plugins/Cooperate.js` 2211–2267 行）：父节点已在渲染器里时，向 `nodeData.children` 插入子节点，然后

```2263:2267:simple-mind-map/src/plugins/Cooperate.js
      renderer.setNodeData(parentNode, {
        expand: true,
        childCount: Math.max(count, live)
      })
      this.mindMap.render()
```

父节点原先折叠也会被打开，随后整棵当前可见树重新布局。父节点不在渲染器里时，函数返回 false，`applyV2RemoteOperation` 第 2192 行退回 `syncHttpRemoteOperations`（4819–4842 行）：按受影响 uid 补路径，再 `render()` 一次。

`map.replaced` 或 `payload.resnapshot`（2026–2039 行）走 `recoverHttpCollab`，这是快照恢复，不是单节点补丁。`complete_todo` / `apply_sop_improvement` / `replace_tree` 的事件带 `resnapshot: true`。它们只有在被客户端应用时才会触发恢复；MCP HTTP 路径本身不推送 `op:event`。

### 5.4 操作为什么会积压成 Gap Sync

- 浏览器只在 `adapter.js` 第 784 行监听 `op:event`。MCP 写入不发这个事件。
- 空闲页面的 `lastServerRevision` 停在旧值。之后任意一条 Socket 操作若 `rev > lastServerRevision + 1`，`applyRemoteOperation`（747–755 行）记录 `REVISION_GAP` 并 `resync()`。
- `resync`（2087 行起）按页拉取 `listOperations`。Sequencer 页大小上限 500（`sequencer.js` 189 行）。每一条再 `applyRemoteOperation`。插入会走到上一节的强制展开和 `render()`。
- 本机 ACK 成功时 `sendOp`（1775–1776 行）直接 `advanceRevision(result.serverRevision)`。`advanceRevision`（602–604 行）只抬高水位，不补应用中间版本。因此正在编辑的客户端可能跳过 MCP 操作；旁观客户端更容易在下一条 `op:event` 上触发整段追赶。

Join 时同样 `listOperations(after, 500)`（`socketServer.js` 227–228 行）。首次打开若本地修订号远落后于被 MCP 刷高的房间版本，Join 回复里就要带上最多 500 条操作；更多的要继续翻页。这是代码路径，不是已测的打开耗时。

## 6. 展开 / 收起（与 MCP 的关系）

点击展开按钮进入 `Render.setNodeExpand`（`Render.js` 2263–2307 行）：

1. 子节点已在内存：`SET_NODE_DATA { expand }`，然后 `mindMap.render()`。
2. 子节点未加载：先 `cooperate.hydrateLazyChildren`，完成后再展开并 `render()`。
3. 收起不等待水合，直接 `expand: false` 并 `render()`。

`Command.exec`（`src/core/command/Command.js` 121–124 行）对个人视图命令直接 return。`isPersonalViewCommand`（`src/utils/personalViewCommands.js`）包含 `SET_NODE_EXPAND`、全部展开/收起，以及只含 `expand` / `isActive` 的 `SET_NODE_DATA`。因此展开/收起：

- 不提交 Sequencer 操作，不等待 ACK，不写 `room_operations` / Outbox。
- 不把 6000 节点树作为协同操作发送。
- 仍然调用一次布局和绘制；布局跳过仍折叠的分支。
- 若子节点是懒加载，会发子树 HTTP。该请求不持有 `rooms FOR UPDATE`，但和 MCP 长事务共用连接池（`storage.js` 第 35–42 行，`PGPOOL_MAX` 默认 20）。池耗尽时水合会排队。这一点没有池等待日志，不能当成已测事实。

多人在线时展开变慢，代码上只能落到两类已存在的机制：别人的 `op:event` 在主线程里 `render()`，或者子树请求/本机其他操作堵在被 MCP 占住的数据库和连接上。人数本身只增加 presence 广播（`socketServer.js` 的 `presence`），presence 不改节点树。没有对照实验，不能把「人多」和「操作多」分成百分比。

## 7. 首次打开

代码阶段与是否已有计时：

| 阶段 | 代码落点 | 本轮计时 |
| --- | --- | --- |
| HTML/JS/CSS | 未在本轮拆网络瀑布 | 无 |
| 登录与 ACL | Join 时 `assertRoomAccess`（`socketServer.js` 204 行） | 无 |
| Join | `listOperations` 最多 500 条 + `getRoomVersion` + metadata | 无 |
| 6000 节点加载 | 首屏懒加载/子树接口，不在 MCP 写路径里重新审计完 | 无 |
| 反序列化与索引 | `readRoomNodes` → `decodeNodeRows` | 无 |
| 首次布局绘制 | `Render._render` → `doLayout` | 无 |
| Outbox / Gap | Join 的 sync 页；落后修订号会在客户端继续 `resync` | 无 |
| 在线成员 | `presence.list` 随 Join 返回 | 无 |

冷启动、刷新、缓存再开这三种没有录制。LCP 53 秒未映射到上表任何一行。

## 8. 对照实验状态

下列组别都没有在本环境跑出耗时。不允许用架构推断填数字。

| 组别 | 要比较的量 | 状态 |
| --- | --- | --- |
| A. 1 人，展开/收起同一节点 | 主线程布局、有无远程 `op:event` | 未测 |
| B. 10～15 人在线但不操作 | 相对 A，只应多 presence | 未测 |
| C. 同房间其他人持续编辑 | ACK 等待、远程应用、`render` 次数 | 未测 |
| D. 多人在不同房间 | 若变慢则更像进程/池，而不是该房间行锁 | 未测 |
| E. 不同节点规模重复 A–D | 确认是否随全图节点数而不是可见节点数增长 | 未测 |
| MCP 关 / MCP 在但空闲 / MCP 持续 `add_node` | 展开、收起、首次打开 | 未测 |

MCP 空闲时期望接近「MCP 关」：空闲不调用 `writeMap`。若空闲也慢，原因不在本文件追踪的写入链。

## 9. 瓶颈优先级（按代码结构，不是按实测毫秒）

1. MCP 单节点走 `commitRoomOperation`，在 `rooms` 行锁内整图读取和 `canonicalizeNodes`。这是唯一随 6000 节点增长、并且阻塞同房间 Sequencer 写入的步骤。
2. 每次写入前的 `format=meta` 再做一次全表读和两次整图哈希。
3. Agent 把批量编辑拆成多次 `add_node` / `update_node`。
4. 位置重排时增量写失效，单次插入升级为整表 `room_nodes` 写。
5. 旁观端 Gap Sync 把积压的 MCP 操作逐条应用到画布，并强制展开父节点后 `render()`。
6. 每 100 个版本在同一事务写 `room_snapshots`；每 200 个操作历史检查点。二者放大持续写入，不是每一次插入的必经路径。
7. 在线人数本身（presence）没有节点布局。它只有和 C 组并发编辑或第 5 条追赶叠在一起时才表现为「人多就卡」。

## 10. 最小修改建议与一致性影响

本轮不实施。若下一轮只做最小改动，按这个顺序，并且不要删 Outbox、不要换 OT/CRDT、不要改权限和撤销。

| 建议 | 一致性影响 |
| --- | --- |
| 让 MCP `/nodes` 走现有 `sequencer.submitOperation`（direct apply），仍写 `room_operations`、Outbox、`pg_notify`，并在提交后向 `v2:` 房间补发与 Socket 相同的 `op:event` | 与浏览器写入同一排序和同一广播。必须保留 `operationId` 幂等、`baseVersion` 校验和 `clientId`。不要绕过 ACL |
| 在补上广播之前，禁止用「跳版本的 ACK」掩盖缺口；旁观端追赶应保留，但应用插入时不要把用户折叠的父节点强制 `expand: true` | 少一次全可见树布局。折叠状态今天是个人视图，不进协同操作；改渲染不要改节点正文 |
| `format=meta` 只查 `rooms.version`，不要 `getRoomSnapshot` | 只影响修订号读取。写入事务仍要自己的权威读 |
| 为 Agent 增加一次提交多节点的现有 batch 入口，而不是在 MCP 进程里循环 `add_node` | 一次版本、一次广播。失败语义要定义成整批回滚，避免半棵树 |
| 诊断开关分开记录：meta 读、锁等待、canonicalize、节点写、Outbox、客户端 `applyV2RemoteOperation` 与 `render` 次数 | 只加日志，不改提交结果 |

## 11. 需要补充的录制（没有这些就不能写毫秒结论）

服务端，在 MCP 持续 `add_node` 时打开已有开关即可，不必先改协议：

- `COLLAB_QUERY_STATS=1`：看 direct 路径的 `queries/reads/writes`。当前 MCP 路径不经过 Sequencer，这条日志**不会**出现在 `add_node` 上。若打开后仍然没有 `[COLLAB_QUERY_STATS]`，可以印证 MCP 没走 Sequencer。
- `collabTrace`：对比是否出现 `5.server.recv` / `9.broadcast`。MCP 现状不应出现 `9.broadcast`。
- PostgreSQL：该房间 `rooms` 行锁等待（`pg_locks` / `pg_stat_activity.wait_event`）、事务持续时间、`room_nodes` 顺序扫描行数。
- 连接池：活跃连接数是否顶到 `PGPOOL_MAX`。
- 一次 `add_node` 的两段 HTTP 耗时：meta 与 POST。

浏览器，三种 MCP 状态各录一次展开和收起，节点规模固定，可见节点固定在约 145：

- Performance：Long Task、`Render._render` / `doLayout` 次数、`applyV2PayloadInsert` 次数、Gap Sync 拉到的操作条数。
- 不要记录节点正文、令牌、cookie。
- 首次打开另录冷启动、普通刷新、缓存再开的网络瀑布，并标出 LCP 元素。只报 LCP 总秒数无法对应第 7 节的阶段。

对照人数时保持「其他人是否发 `op`」这个变量单独变化。B 组不应产生 `op:event`；C 组应该产生。D 组应把 MCP 写到另一个房间，用来区分行锁和整个数据库。

## 12. 回归清单（实施第 10 节之前）

- 单客户端 `add_node` 后刷新，节点还在，版本 +1，Outbox 最终发布。
- 重复同一 `operationId` 不产生第二版。
- `baseVersion` 大于当前版本仍返回 `VERSION_AHEAD`。
- 无编辑权限的 MCP 令牌被拒绝，且不留半行。
- 浏览器折叠父节点下被 MCP 插入子节点后，未打开该父节点的客户端不被迫展开；打开后能看到新节点。
- 旁观端在 MCP 连写之后，下一次用户编辑仍能补齐中间版本，不丢节点、不重复节点。
- `replace_tree` 仍是单次整图替换，并继续写历史检查点。
- 撤销/重做、SOP 确认、附件挂载冲突语义不变。
- 1 人展开/收起与 MCP 持续写入同时进行时，展开不依赖 MCP 的 ACK。
