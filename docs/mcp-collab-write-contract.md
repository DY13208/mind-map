# MCP 节点写入与协作契约

本契约对应 MCP 普通节点写入、移动及 `apply_nodes`。工具响应新增字段为向后兼容扩展；调用方必须检查批次结果，不能把 HTTP 200 或没有 `isError` 解释为全部项目完成。

## 写入路径

- 服务端校验 MCP 身份、房间编辑权限与节点业务规则。UID 定位的普通文字、备注、超链接、新增、删除和移动可进入 Direct 路径；SOP 等守卫仍然生效。
- `COLLAB_V2`、`COLLAB_V2_EVENT_BRIDGE`、`COLLAB_MCP_DIRECT` 同时开启，且房间节点表就绪，才允许增量写入。
- `submissionPath` 表示这次请求实际走的路径；兼容路径同时返回 `fallbackReason`。路径、复杂附件和整图替换不强制进入普通节点 Direct 执行器。
- 批量不拆成多个 HTTP 写入。Direct 关闭、节点表未就绪或批次形状不受支持时明确返回能力错误，并带上可用的 `details.fallbackReason`；不能自动改成循环单节点写入。Direct 不可用不代表项目没有批量接口，而是当前实例未满足批量执行条件。

## 移动

`move_node(room_key, uid, parent_uid, index?, operation_id?, base_revision?, confirm_sop_change?)` 通过现有移动接口调整父节点与顺序。`parent_uid` 可为 `root`；不接受标题猜测。保持 UID、子树、附件、超链接和历史关联，不使用删除再新增。

根节点、循环关系、已删除目标、无权限及未确认的 SOP 修改明确拒绝。`index` 省略时沿用现有移动排序规则。

## 并发前置条件

- 修改已有节点的 `text`、富文本内容、`note`、`hyperlink` 或 `hyperlinkTitle` 时，`expected` 必须含 `uid` 和每个被改字段组的 `__fv.text`、`__fv.note`、`__fv.hyperlink`。旧节点缺少字段版本时按 `0` 处理；同一批多次操作按批次开始时的不可变基线校验，批内成功的前序修改不会被误判为外部冲突。
- `query_nodes` 默认返回保持原样。需要直接复用的并发条件时传 `include_write_hints: true`，再将该节点 `write_hints.update.text`、`write_hints.update.note` 或 `write_hints.update.hyperlink` 中对应对象原样放入 `expected`。例如查询结果中的 `data.__fv.text=12` 对应 `{"uid":"node-123","__fv.text":12}`。提示来自本次读取，不保证写入前未发生新修改；同名候选不会提供写入提示。
- `data.__fv.text`、`data.__fv.note`、`data.__fv.hyperlink` 是字段版本；响应顶层 `version` 是房间修订号。可选 `base_revision` 不能替代 `expected` 中的字段版本。`"__fv.text"` 是完整 JSON 键名，不能改写成 `"__fv":{"text":12}`。只改一个字段组时只需提供该字段组的版本；`hyperlink` 与 `hyperlinkTitle` 共用 `__fv.hyperlink`。工具示例中的数字仅说明结构，实际值须来自本次查询。
- 节点 `text` 参数传纯文字，不把 HTML 标签当作富文本格式协议。
- 移动/重排已有节点必须提供 `expected.uid`、原 `parent_uid` 和原 `position`。当请求指定零基 `index` 时，还必须提供 `expected.anchor_uid`、`anchor_parent_uid`、`anchor_position` 与 `anchor_side`（`before` 或 `after`），或者 `expected.target_empty=true`。锚点方式会在事务锁内重新找到锚点并计算相对位置；锚点在本批前序操作中被删除或移动时返回 `REPLACE_CONFLICT`。空目标方式要求锁内目标父节点除源节点外没有子节点，否则返回 `REPLACE_CONFLICT`。省略 `index` 表示追加到末尾。可选 `target_uid`、`target_parent_uid`、`target_position` 用于校验目标父节点未变化。
- 删除必须提供 `expected.uid` 与 `expected.subtree_token`。先用 `query_nodes(scope="self", selector={type:"uid", value:"..."}, include_subtree_token=true)` 读取节点，返回值包含其完整子树摘要；该摘要是对 `(uid,parent_uid,position,node_version)` 排序后的行元组计算的 SHA-256。子树新增、移动、更新或删除都会改变摘要。数据库及写入路径无法计算摘要时明确拒绝，不会退回无保护删除。
- 缺少必要校验信息返回 `PRECONDITION_REQUIRED`（HTTP 428）；基线已变化返回 `REPLACE_CONFLICT`（HTTP 409）。`apply_nodes` 将这些请求级业务错误作为固定的逐项失败回执保存；相同操作 ID 重放优先返回原回执，不会用新基线重试。
- 批量不可用时一并检查 MCP 错误中的 `code`、`statusCode` 和可用的 `details.fallbackReason`。外层 MCP HTTP 200 不代表业务成功；`writeSubmitted=true` 只表示请求已提交给后端，不代表修改已落库。`outcome=rejected` 表示明确拒绝；`outcome=unknown` 或 `outcomeUnknown=true` 才表示结果未知。
- HTTP、MCP Direct、V2 Socket 与 legacy 兼容写入使用同一前置条件语义。兼容路径无法取得完整删除子树索引时返回 `PRECONDITION_UNSUPPORTED`，不会跳过校验。undo/redo 使用现有操作冲突验证，其内部逆操作不要求外部 MCP CAS 字段。

文字修改示例（版本数字仅演示结构，必须替换为本次查询返回值）：

```json
{
  "room_key": "示例房间",
  "node": "目标UID",
  "text": "修改后的纯文字",
  "expected": { "uid": "目标UID", "__fv.text": 12 }
}
```

`query_nodes.include_write_hints` 是可选布尔参数，默认关闭；开启后分页续读必须保持该参数不变。只在目标明确时生成提示，且提示计入查询原有的字节预算。分片内容仍须读完；提示不会授予写权限，也不会锁住节点。异常字段版本只省略对应组并返回 warning，不编造条件。

MCP 对相关错误附加 `guidance`（逐项失败时位于该 item），包含原因、所需键名、条件来源和下一步动作；原 `code`、状态、逐项结果和持久化回执不变。`guidance` 只供解释，不是服务端自动换基线或重试的指令。

## 批量部分成功

- `apply_nodes` 最多 100 项。按输入顺序执行，允许独立项目部分成功；只提交成功项目的事件与逆操作。
- `depends_on` 是同批此前项目的**零基下标数组**。例如第 2 项依赖第 1 项，使用 `[0]`。不能引用自身、后续项或重复下标。
- 对本批新增父节点的依赖也会识别；前置项失败时依赖项返回 `dependency_failed`，不尝试写入。无依赖的其他项目继续。
- 节点冲突等可恢复业务错误使用保存点隔离。格式错误、房间无编辑权限在执行前拒绝；连接中断等系统错误回滚整次事务，不当作普通项目失败继续执行。
- 有成功项时，整个批次产生一个房间版本。全部失败时不增加版本、不写操作记录，但会在同一事务中保存终态回执；原 `operation_id` 重放返回首次的逐项结果和版本，不重新执行。不同身份或不同请求内容复用该 ID 会得到冲突；核实后补处理仍须使用新 ID。

响应包含 `outcome`、`count`、`failed` 和 `items`：

| 字段 | 含义 |
| --- | --- |
| `outcome=applied` | 项目全部成功 |
| `outcome=partial` | 一部分成功，一部分失败或依赖失败 |
| `outcome=all_failed` | 无成功修改，版本不变 |
| `items[].index` | 原请求中的零基下标 |
| `items[].status` | `applied`、`failed` 或 `dependency_failed` |
| `items[].result` | 成功项目的服务端结果，例如 UID 与位置 |
| `items[].code` | 失败码；调用方据此核实，而不是忽略该项 |

批次重复请求使用原 `operation_id` 返回首次已提交结果，不重新执行失败项。AI 应展示部分完成状态；遇到 `REPLACE_CONFLICT` 或 `PRECONDITION_REQUIRED` 必须报告并等待用户后续指示，不能自动读取新条件重写旧内容。其他失败核实后只补处理失败项，并为新意图生成新操作 ID。超过 100 项分批提交，禁止用循环单项调用代替已知批量意图。

遇到 `PRECONDITION_REQUIRED`（428）或 `REPLACE_CONFLICT`（409）时，向用户说明并等待后续指示。不要自动重读最新版本、替换旧意图中的 `expected` 后重试；用户决定继续时，先重新读取，再确认新的条件与写入意图。

## 重试、恢复与取消

自动重试固定首次实际提交的修订号、操作 ID 和内容。`base_revision` 可显式携带原提交修订号；它用于版本恢复边界校验，不代表当前房间版本必须与它相等。

成功响应附带实际使用的 `base_revision`。写请求可能已发出但结果未知时，错误结构也返回相同的 `base_revision` 与 `writeSubmitted=true`，便于调用方在进程重启后使用原操作 ID、内容和修订号重放。若读取房间元数据失败、写请求尚未发出，错误返回 `writeSubmitted=false`，且不提供 `base_revision`。

`STALE_AFTER_VERSION_RESTORE` 是终态冲突。禁止自动读取恢复后的版本重新提交旧意图。跨 MCP 进程重启继续重试时，调用方须保留操作 ID、原内容和提交修订号；本轮不新增持久化失败意图表。

超时或响应丢失可能发生在提交之后。`outcome=unknown` / `outcomeUnknown=true` 表示结果未知，不能宣称“没有写入”，也不能换新 ID 再新增。使用原 ID 查询/重放已提交结果后再判断。排队期间取消会移出队列；已提交修改不能通过取消撤销。

## 协作与诊断

服务端操作仍按连续版本传播，客户端应用成功才推进水位。批次仅回放服务端成功子事件，不回放包含失败项的原请求。远端连续事件只合并渲染，不丢弃同一 UID 上的多次操作。

同一父节点下新增不同 UID 的子节点互不构成内容冲突；新增不校验或推进父节点的文字字段版本。浏览器自动打开新节点编辑时，首次服务端字段版本可能尚未返回：文字保存等待该节点的新增回执，只能从本客户端对应新增请求的成功回执中，一次性接受内容初值未变的初始化版本，并保留当前输入。既有新增通道若明确返回 `resetRichText=true`，只在原富文本提取的文字与回执纯文字完全一致时接受这次格式归一化；会话基线记录实际服务端值，输入草稿保持不变。它不能读取最新条件补写，不能采用其他请求、其他房间或较旧回执覆盖已知的新内容。自身保存的成功回执不向该保存会话报告“他人修改”；实际同 UID、同字段竞争仍按原条件拒绝并保留草稿。

诊断为有界、按进程采样。`get_performance_diagnostics` 的 `after` 只用于后端，新增 `writer_after` 用于 MCP 写入进程；响应的 `mcpWriter` 包含该进程的队列及采样。采集时不得混用游标；重启或 `cursorResetRequired` 后重置游标。`retentionGap` 表示样本已被容量覆盖，不能将缺失样本计为零延迟或零错误。

`lock-query` 是查询往返而非纯锁等待；提交、传播、应用与布局分别统计。诊断不记录节点正文、认证头、Cookie、Token 或 SQL 文本。

## 数据库与发布

必须在启动包含本轮 MCP 写入代码的任何实例**之前**，显式应用 `009_mcp_archive_operation_id_index.up.sql` 与 `012_mcp_terminal_receipts.up.sql`，并分别核实归档操作 ID 索引和终态回执表结构有效。`012` 新增 `mcp_terminal_receipts` 表，仅保存房间/操作标识、MCP 主体、请求摘要、首次终态逐项结果、首次房间版本和创建时间；不保存失败意图或原始请求正文。已验证 MCP 写入会查询该表以阻止同一操作 ID 跨工具类型复用，因此缺少 `012` 时所有 MCP 写入均以 `MCP_OPERATION_RECEIPT_SCHEMA_MISSING` 确定拒绝且事务回滚，不会执行写操作。普通请求不运行迁移 DDL。

每个唯一的 `all_failed` 批次最多增加一条终态回执；已提交的批次使用现有操作记录保存幂等结果。回执没有 TTL 或自动清理计划，以保留跨实例、恢复和节点状态变化后的重放语义；物理清除房间时通过外键级联删除。只有在彻底停用新版 MCP 写入并确定不会再启动依赖该表的代码后，才可执行 `012_mcp_terminal_receipts.down.sql`。仅为性能回滚关闭 Direct 时不能删除该表。

`009` 的索引脚本使用 `CONCURRENTLY`，不得放入显式事务。`012` 的结构回退会删除全部失败批次的幂等回执，已提交批次仍由操作记录保护；执行 down 前必须彻底停用依赖该表的新版 MCP 写入代码，仅关闭 Direct 不足以回退结构。

部署前同时核对上游 `010_node_count_cache_generation`（新增房间计数 generation、触发器与索引）和 `011_access_request_roles`（申请授权角色、理由、已读时间及角色约束）的准备情况。`010` 按脚本要求在事务中执行；计数缓存开关只能在所有写入者就绪后开启。`011` 回滚若将丢失新角色或申请数据会明确拒绝。

后续部署时先部署兼容服务与前端，验证事件桥，再启用 Direct。启用前确认 `009_mcp_archive_operation_id_index`、`012_mcp_terminal_receipts` 及当前版本要求的迁移已应用并核验。先在测试实例启用事件桥，验证 `/api/health` 的监听健康、落后房间、补偿、重复通知及队列指标；再启用 Direct，在隔离测试房间确认 `submissionPath=direct` 并执行真实批量验收。仅更新 MCP 客户端说明不会启用服务端能力。远端发布和开关变更需独立安排；只读核查不代表已发布或启用。

回滚优先关闭 Direct 并保留事件桥及兼容、恢复能力；关闭后批量明确不可用。不要因关闭 Direct 删除幂等索引或终态回执表。回退软件版本前确认旧版本可以识别现有操作记录、回执及逆操作格式。性能验收和远端部署结果另记于验收报告，不由本文档声称通过。
