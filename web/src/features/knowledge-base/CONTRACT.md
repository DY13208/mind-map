# 文件知识库前端接口契约

对照 `services/file-kb`（2026-10-16；上传/表头映射/批次部分于 2026-10-19 按当时工作区后端源码复核，后端仍在并行开发，未部署前以运行版本为准）。统一入口 `services/kbApi.js`：`baseURL=/api/kb`，`withCredentials=true`，超时 15s，上传不限时，请求头 `X-Requested-With: XMLHttpRequest`。变更请求还要带与页面 `Host` 一致的 `Origin`，后端不接受用 `X-Requested-With` 代替来源校验。

两个开关分开。`FILE_KB_UI_ENABLED` 只决定侧栏入口和页面能否打开，缺省为打开。`FILE_KB_ENABLED` 才是后端服务：默认 false。nginx 在它关闭时对 `/api/kb/*` 返回 404 `kb_disabled`，前端显示「服务未就绪」和空状态，不填假数据。本文件不代表已经对生产环境完成联调。

## 错误

`services/kbErrors.js#normalizeKbError` 归一化为 `{ status, code, kind, message, backendNotReady, data }`。

| HTTP / code | kind | 前端表现 |
|---|---|---|
| 404 `kb_disabled` | `disabled` | 文件知识库未启用 |
| 404 无 code，或 code=`not_found`，以及 405 | `not_ready` | 后端未就绪 |
| 404 `missing` | `not_found` | 资源不存在或无权查看（无权限也用这个码，避免泄露是否存在） |
| 401 | `unauthorized` | 请先登录 |
| 403 `forbidden` / `origin_denied` | `forbidden` | 无权限 / 请求来源被拒绝 |
| 501 `not_implemented` | `not_implemented` | 该能力尚未实现（语义检索）。服务本身是通的 |
| 409 `FOLDER_NOT_EMPTY` / `OWNER_ANCHOR` / `job_in_progress` | `conflict` | 文件夹非空 / 不能改所有者锚点 / 已有解析任务 |
| 400 `OWNER_SINGLE` | `invalid` | 不能把 ACL 角色设为 owner，要走所有权转移 |
| 502 / 503 / 504，`auth_unavailable` | `unavailable` | 服务暂不可用。health 的 503 仍带 `{ok,db,docling,queue}` |
| 无响应 / 超时 | `network` / `timeout` | 网络异常 / 请求超时 |

## 分页

列表是游标分页。请求 `limit`（默认 50，文件/文件夹/记录上限 200，检索上限 50）和 `cursor`（首页不传）。响应同时给 `items` 与具名数组，以及 `next_cursor` / `nextCursor`。`total` 在带 cursor 的文件列表上可能为 null。过滤条件变化时丢掉游标。查询参数 snake_case，空值不发送。前端也接受 camelCase 别名。

## 行号

数据库 `row_index` 从 0 开始，等于表格行号减 1。

- `GET /records` 和 `GET /search` 的 `row`、`source.row` 已经是表格行号。页面直接显示，不再加 1。
- 若响应里出现 `row_index` 或 `rowIndex`，展示为 `row_index + 1`，不能把 0 显示成第 0 行。
- MCP `query_knowledge_records` 和 `get_knowledge_source` 的 `row` 仍是 `row_index`。调试器展示前换成表格行号。调用 `get_knowledge_source` 时，用户填写的 `row` 是表格行号，请求里发送 `row - 1`。

## 接口

| 方法 | 路径 | 前端函数 | 请求 | 响应 |
|---|---|---|---|---|
| GET | /health | health | – | `{ok,enabled,db:{ok,error?},docling:{ok,status},queue:{queued,running,failed},user:{id}}`。数据库失败时 HTTP 503，结构相同 |
| GET | /folders | listFolders | `parent_id=root\|uuid&limit&cursor` | `{items:[{id,parentId,name,path,effectiveRole,inherit,hasChildren}],next_cursor}`。`root` 同时包含父级对当前用户不可见的文件夹（例如单独分享的子文件夹） |
| POST | /folders | createFolder | `{name,parentId?,reuse?}` | 201 folder。父级需要 editor。`reuse:true`（文件夹上传用）：同一父级下已有同名且当前用户可编辑的文件夹时返回它（200，`reused:true`），按（父级, 名称）串行，并发也只建一个；根目录只沿用自己的文件夹 |
| PATCH | /folders/:id | renameFolder | `{name,parentId?,updatedAt?}` | folder。改父级需要 manager，拒绝成环。时间戳不一致 409 `stale_update` |
| DELETE | /folders/:id | deleteFolder | – | `{id,deleted:true}`。非空 409 `FOLDER_NOT_EMPTY`。需要 manager |
| GET | /files | listFiles | `folder_id&q&status&limit&cursor`；轮询 `ids` 最多 50 个 | `{items:[{id,folderId,name,ext,mime,size,status,statusDetail,error,parseVersion,updatedAt}],next_cursor,total?}` |
| POST | /files | uploadFile | multipart 字段 `file`；`folder_id` 同时放在查询串和表单字段（令牌限定文件夹时后端在读正文前就要查询串里的 folder_id）；可选查询 `batch_id`、`client_key`（批次上传时传，见下文「批次任务」） | 单文件：文件对象本身，另带 `duplicate`、`files`、`rejected`；201 新建，200 去重命中（返回已有文件，可能在其他文件夹）。全部被拒：400/413，正文 `{files:[],rejected:[{name,code}],code}`。详见下文「上传」 |
| GET | /files/:id | getFile | – | file，另含 `runs`、`jobs`、`counts` |
| PATCH | /files/:id | updateFile | `{name?,folderId?}` | file。需要 editor |
| DELETE | /files/:id | deleteFile | – | `{id,deleted:true}`。需要 manager |
| POST | /files/:id/reparse | reparseFile | – | 202 `{id,status,runId,jobId}`。需要 editor。已有任务 409 `job_in_progress` |
| GET | /jobs/failed | listFailedJobs | – | `{items:[{id,fileId,fileName,ext,fileStatus,kind,attempts,maxAttempts,lastError,failedAt,canRetry}],total}`。只含当前用户可见、未删除文件的最新一次任务；已被新任务取代的失败不计入。`/health` 的 `queue.failed` 仍是全库原始计数，页面不再用它提示 |
| POST | /jobs/:id/dismiss | dismissJob | – | 200 `{id,dismissed:true}`。需要 editor；任务置为 `cancelled` 并记审计 `job.dismiss`。非失败状态 409 `job_not_failed` |
| GET | /files/:id/layout | previewLayout | – | `{fileId,sheets:[{name,confidence,needsConfirmation,confirmed,headerRows,dataStartRow,columns,preview,regions}]}`。只读原始 Excel 的前若干行，不改文件。非 xlsx 为 415 `not_excel` |
| POST | /files/:id/structure | restructureFile | `{sheets:[{sheet,headerRows,dataStartRow,columnOverrides}]}`，前端只发 `columnOverrides`（只含用户明确改过的列 `{index,name}`），不再发旧的 `columns` 快照 | 202 `{id,status,runId,jobId}`。只重新结构化，不调用 Docling，不改原始文件。表头行必须早于数据起始行，否则 400 `bad_layout`。低置信度的自动结果不会替换当前有效版本 |
| GET | /files/:id/blocks | getBlocks | `limit&cursor` | `{items:[{id,seq,type,text,page,bbox,sheet,row,cell,headingPath}],next_cursor,runId,status?}`。`bbox` 为 0–1 的 `[x0,y0,x1,y1]` |
| GET | /files/:id/raw | rawUrl / getRaw | – | 原文件字节。无权限 404 `missing`。对象丢失 410 `object_missing` |
| GET | /fields | listFields | `file_id` 必填 | `{fields:[{key,label,type,sheet,column,colIndex,inferredType,headerRow,confidence,confirmed,tableIndex}]}`。未选文件时前端不请求 |
| GET | /records | listRecords | `file_id?&limit&cursor&filters` | `{items:[{id,fileId,fileName,sheet,row,data,sku,price,stock,recordDate,source}],next_cursor,total}`。`row` 为表格行号 |
| GET | /search | search | `q` 必填，`mode=hybrid\|keyword\|semantic`，`folder_id?&limit&cursor` | `{items:[{fileId,fileName,blockId,page,sheet,row,snippet,score,source}],next_cursor,total}`。`semantic` 为 501 `not_implemented`，不返回假命中 |
| GET | /mcp/status | mcpStatus | – | `{ok,url,transport,version,tokenPrefix}`。`url` 是路径；页面用当前访问源拼绝对地址。只有前缀 |
| GET | /mcp/tokens | listMcpTokens | – | `{items:[{id,name,tokenPrefix,scopes,scopeFolderIds,createdAt,expiresAt,revokedAt,lastUsedAt}]}`。没有明文、没有哈希 |
| POST | /mcp/tokens | createMcpToken | `{name?,ttlDays?,scopeFolderIds?,scopes?}` | 201 `{id,name,tokenPrefix,token,scopes,scopeFolderIds,expiresAt}`。`token` 只此一次。缺省 scopes 为 `kb:read`；新建令牌只接受 `['kb:read']` 或 `['kb:read','geekcloud:read']`，否则 400 `bad_scope`（越权申请 kb:write/kb:admin 仍是 403）。带 `scopeFolderIds` 又带 `geekcloud:read` 是 400 `geekcloud_scope_folder_conflict`。`ttlDays` 可选，须为正整数，否则 400 `bad_ttl`；不传时用 `FILE_KB_MCP_TOKEN_DEFAULT_TTL_DAYS`，未设置（或为空）则永久（`expiresAt:null`），可随时撤销。`FILE_KB_MCP_TOKEN_MAX_TTL_DAYS` 可选：设置后超出上限或 `permanent:true` 是 400 `bad_ttl`，未传 ttl 时按上限。前端两处都默认永久，MCP 接入页不传 `ttlDays` |
| DELETE | /mcp/tokens/:id | revokeMcpToken | – | `{id,revoked:true}`。下一 MCP 请求即失效。他人的令牌是 404 `missing` |
| GET | /mcp/tools | mcpTools | – | `{tools:[{name,description,inputSchema}]}`。调试器只保留七个只读工具 |
| POST | /mcp/call | mcpCall | `{tool,arguments}` | 工具结果。调试器丢掉 `userId` / `ownerId` / `actorId` / `subjectId` / `token`，并掩掉凭据字段 |
| GET | /acl/:type/:id | getAcl | type=`file`\|`folder` | `{name,inherit,ownerUserId,effectiveRole,capabilities,grants}` |
| PUT | /acl/:type/:id | putGrant | `{subjectType,subjectId,role}` | 同 GET。`role` 只能是 viewer、editor、manager。`owner` 为 400 `OWNER_SINGLE` |
| DELETE | /acl/:type/:id | deleteGrant | `{subjectType,subjectId}` | 同 GET。不能删除所有者锚点（409 `OWNER_ANCHOR`） |
| POST | /acl/:type/:id/transfer | transferOwner | `{userId}` | 同 GET，调用方视角变为新所有者。只改当前资源的 `owner_id`，不改子资源。原所有者变为该资源的 manager |

上级文件夹所有者（迁移 009）：资源所在继承链（`resource_chain`，遇到 `inherit_acl=false` 截止）上任一文件夹的所有者，对该资源至少是 manager（可读写、授权，不能转移所有者）。`describeAcl` 为其返回 `{source:'inherited', via:'folder_owner', role:'manager', inheritedFrom}`，界面只读显示；同一人更低的直接授权 `applied:false`。没有拒绝类授权。

文件夹上传：上传面板「选择文件夹」（`webkitdirectory`）或拖入目录（`webkitGetAsEntry`）。在当前选中的文件夹下按相对路径逐层 `POST /folders {reuse:true}`（父级完成后才建子级，同一路径只建一次，网络错误/超时/503/429 最多重试 2 次），再把文件按目标文件夹交给原上传队列（重试、去重、429 退避、批次不变）。跳过隐藏/系统文件（任意一级以 `.` 开头、`__MACOSX`、`~$` 锁文件、`.DS_Store`、`Thumbs.db`、`desktop.ini`），大小/类型不合格的文件不上传，只装着跳过文件的目录不建；单次最多 1000 个文件夹、32 层、读取 20000 个条目。去重仍按内容：同内容文件已在别的文件夹时返回已有文件，不会复制。

权限界面：`KbPermissionDialog` 直接复用脑图的 `ShareFolderDialog`（`adapter` 属性，默认 `null` 时脑图行为不变），数据由 `services/kbAclAdapter.js` 转换。成员来自企业通讯录 `/api/wecom/contacts`，其 `id` 即主应用 `user_id`，直接作为 `subjectId`。部门只用于批量选人，保存时逐人 `PUT`（后续新成员不会自动获得）；「按部门/团队整体授权」显示为暂不可用（`kb.teams` 没有任何同步来源）。仅继承的授权只读，需到来源文件夹调整。没有 `grant` 能力时整页只读。角色：可查看=viewer、可编辑=editor、可管理=manager，所有者只能转移。

外部客户端走 `/file-kb-mcp/mcp`，传输与脑图 MCP 相同：Streamable HTTP，`type: http`，`Authorization: Bearer`。调试器仍走登录会话的 `POST /mcp/call`，不把令牌放进调试参数。令牌管理页只在创建成功时显示一次明文，不写入 localStorage。复制用的长期模板使用环境变量 `FILE_KB_MCP_TOKEN`。

筛选 `filters` 为 JSON 数组：`{field, op:'eq'|'contains'|'range', value?, min?, max?}`。字段若带 `column`（sku / price / stock / record_date），请求使用 `column`，以便打到类型化列。

### capabilities

前端只认后端返回的字符串，不按角色名推断按钮：

- `grant`：新增或修改 viewer、editor、manager
- `revoke`：移除直接授权
- `transfer`：转移当前资源的所有权。必须先确认，文案写明不自动转移子资源

不再使用 `grant_owner`。所有者仍在授权列表里展示（来源为所有者），但不能通过普通授权授予或改成 owner。

角色：viewer 查看者，editor 编辑者，manager 管理者，owner 所有者。
文件状态：pending 等待解析，parsing 解析中，structuring 结构化入库中，done 已完成，partial 部分完成，failed 失败。

### 七个只读 MCP 工具

`list_knowledge_files`、`search_knowledge`、`query_knowledge_records`、`get_knowledge_document`、`get_knowledge_block`、`get_knowledge_source`、`get_knowledge_import_status`。外部 MCP 另有第八个工具 `smart_knowledge_query`（见下文吉客云一节）；`GET /mcp/tools` 和调试器仍只列这七个。

## 吉客云数据源与 smart_knowledge_query（2026-10-19）

后端：`services/file-kb/src/geekcloud/`。前端：`components/KbGeekcloudPanel.vue`，挂在 MCP 页底部。Key 只在服务端 `.secrets/geekcloud.env`（其余 `FILE_KB_GEEKCLOUD_*` 在 `.env`），前端没有输入框，接口只返回「是否已配置 + sha256 前 8 位指纹」。

| 方法 | 路径 | 前端函数 | 请求 | 响应 |
|---|---|---|---|---|
| GET | /geekcloud/status | geekcloudStatus | – | `{enabled,configured,configErrors[],endpointHost,token:{configured,fingerprint},allowedTools:[{name,label,description}],access:{allowed,reason,warehouses[]},connection:{state,checkedAt,latencyMs},breaker:{failures,open,retryInMs},lastError:{code,message,tool,at}?,limits:{timeoutMs,maxConcurrency,perUserPerMinute}}`。不发外部请求 |
| POST | /geekcloud/check | geekcloudCheck | `{}` | `{ok,state,checkedAt,latencyMs,tools:[{name,label,available,schemaOk,missingProps}],remoteToolCount}` 或 `{ok:false,state,error:{code,message}}`。会向吉客云发一次 tools/list。不在授权名单 403 `geekcloud_forbidden` |
| GET | /geekcloud/calls | geekcloudCalls | – | `{items:[{at,action,tool,status,code,durationMs,via,sku}]}`，只含当前用户最近 20 次 |
| POST | /smart-query | smartQuery | `{query,mode?:'auto'\|'file_only'\|'geekcloud_only'\|'combined',include_file_context?,limit?(1–50,默认10)}` | 见下 |

`connection.state`：`unknown` 未检测、`connected`、`auth_failed`、`unreachable`、`schema_mismatch`、`disabled`、`not_configured`。`access.reason`：`geekcloud_disabled`、`geekcloud_not_configured`、`geekcloud_forbidden`；令牌调用另有 `token_scope_missing`（令牌没有 `geekcloud:read`，即使用户在授权名单）、`token_folder_scoped`（限定文件夹的令牌）。`access` 另含 `owners[]`、`price`。

令牌权限（迁移 `008_mcp_token_geekcloud_scope.sql` 放宽 `kb_mcp_tokens_scopes_chk`）：令牌调用吉客云要同时满足令牌带 `geekcloud:read` 和用户在 `FILE_KB_GEEKCLOUD_ALLOWED_USERS`；登录会话不变。令牌所属用户已不在 `public.wecom_users` 时，令牌认证 401 `token_user_inactive`。

通配：`FILE_KB_GEEKCLOUD_ALLOWED_USERS`、`FILE_KB_GEEKCLOUD_PRICE_USERS` 里的 `*` 表示所有已登录用户；`FILE_KB_GEEKCLOUD_WAREHOUSE_SCOPE`、`FILE_KB_GEEKCLOUD_OWNER_SCOPE` 的键 `"*"` 是没有单独配置用户的默认范围，用户自己的键整体覆盖、不合并。`*` 不能作为货主的值（配置错误，吉客云整体不可用）。仓库范围的值恰好为 `["*"]` 表示全部仓库：库存不发仓库过滤、不按仓库筛行，仍受分页上限（10 页 × 10 行）约束，超出时 `stock.truncated = true`；`"*"` 与仓库编号混写是配置错误。`access` 新增 `allWarehouses`（布尔），全部仓库时为 `true` 且 `warehouses` 为 `['*']`；`lookupSku` 的 `scope` 同样带 `allWarehouses`。全部仓库时「查询可见仓库」不调用吉客云，返回 `{status:'ok', items:[], allWarehouses:true}`。令牌规则不变。`/geekcloud/status` 的 `access` 返回按当前用户解析后的范围。

货主与价格：`FILE_KB_GEEKCLOUD_OWNER_SCOPE` 为 JSON `{用户: [货主名称]}`（格式同 `FILE_KB_GEEKCLOUD_WAREHOUSE_SCOPE`），按商品行 `ownerName` 过滤；没有货主范围 `goods` 为 forbidden `no_owner_scope`，SKU 不在范围内整体 forbidden `owner_out_of_scope`，不返回库存与价格；货品工具不可用时 `owner_unverifiable`。价格只对 `FILE_KB_GEEKCLOUD_PRICE_USERS`（逗号分隔）里的用户查询，否则 `price` 为 forbidden `price_not_allowed`。

smart-query 与 MCP 工具 `smart_knowledge_query` 返回同一结构：

- `route`：`{decision:'file'|'geekcloud'|'combined'|'clarify'|'geekcloud_warehouses', mode, sku, intents[], reasons[], clarification, geekcloudCalled}`
- `sources.geekcloud`：`{source:'geekcloud', dataKind:'realtime', status, queriedAt, sku, scope:{warehouses}, goods:{status,items,candidates}, stock:{status,items[{warehouseCode,warehouseName,currentQuantity,useQuantity,…}],totals,truncated}, price:{status,items}, errors:[{part,code,message}], missing[]}`。`status`：`ok`/`partial`/`error`/`not_found`/`needs_clarification`/`forbidden`/`unavailable`/`bad_request`/`skipped`
- `sources.fileKb`：`{source:'file_kb', dataKind:'historical_file', status:'ok'|'empty'|'error'|'skipped', queriedAt, match:'exact_sku'|'search', records:[{recordId,fileId,fileName,runId,parseVersion,sheet,row,tableIndex,sku,price,stock,data,source}], recordTotal, blocks:[{blockId,fileId,fileName,runId,page,sheet,snippet}], results[]}`
- `comparison`：`null` 或 `{sku, fields:[{field:'stock'|'price', geekcloud, fileKb:[…], differs}], rule}`。只并列，不合并
- `notes[]`、`contentPolicy`

规则：没有恰好一个明确 SKU 时不调用吉客云；`file_only` 或「只查文件」绝不调用；SKU 只作文件筛选条件时只查文件；未授权用户 `geekcloud.status = forbidden` 且没有任何吉客云数据；库存只返回该用户配置的仓库。

## 上传（第二阶段，2026-10-19）

前端实现：`components/KbUploadPanel.vue` + 纯逻辑 `utils/uploadQueue.js`。仍是「单文件接口 × 前端有界并发队列」，没有新的上传框架。

- 并发：默认 3，可在面板里调 1–6；任何时刻进行中的请求数不超过该值。后端另有每用户同时上传上限 `KB_UPLOAD_CONCURRENCY_PER_USER`（缺省 4）、每分钟文件数 `KB_UPLOAD_FILES_PER_MINUTE`（缺省 120）、每用户进行中任务 `KB_MAX_QUEUED_PER_USER`（缺省 50）。
- 自动重试（`utils/uploadQueue.js#RETRY_POLICY`，每个文件独立）：
  - 限流 429（`too_many_concurrent_uploads` 3s 起、`rate_limited` 15s 起、`queue_full` 20s 起，其他 429 10s 起）：最多 20 次；
  - 服务暂不可用 502/503/504：5s 起，最多 5 次；
  - 网络中断 / 超时：3s 起，最多 3 次；
  - 指数退避 ×2，等量抖动（一半固定 + 一半随机），单次最长 60s；后端给了 `Retry-After`（秒或 HTTP 日期）或正文 `retryAfterMs` 时不早于它（工作区后端对所有 429 返回 `Retry-After: 1` 和 `retryAfterMs:1000`）；
  - 每个文件累计自动等待不超过 10 分钟；任一上限到达即标为「失败·未提交」，可手动重试（手动重试重置计数与预算）。原先 30 次×最长 60s 的策略最坏约 27 分钟/文件，已取消。
  - 取消单项、取消未完成、组件销毁都会清掉重试计时器并 abort 进行中的请求；销毁后不再回调。
- 幂等（只读核对 `api.js#upload` 与 `001_kb_schema.sql`）：后端按 `(coalesce(team_id,''), owner_id, sha256)`（未删除）唯一，先查后插，并发时 `on conflict do nothing` 再查。响应丢失后重试同一内容会返回已有文件且 `duplicate:true`，不会新建文件、parse run 或任务。与文件夹无关：已有文件在别的文件夹时也返回那个文件，不会复制到当前文件夹。后端不读 `Idempotency-Key`，前端不发；没有按 sha256 查询文件的接口，前端也不在重试前预查。之前请求结果未知（网络中断、超时、502/504、其他 5xx）而重试得到 `duplicate:true` 时，界面显示「上次请求结果未知；后端按内容识别为已有文件，没有重复创建」，不算作重复文件。
- 503 视为请求未进入上传处理（认证不可用或无上游），502/504/网络中断视为「可能已被后端接收」。字节已全部发出后被取消的文件，提示「后端可能已接收，请以文件列表为准」。
- 同一文件（名称 + 大小 + 修改时间 + 目标文件夹）在本地队列里只保留一项：重复选择时跳过；之前失败或取消的同一文件再次选择时重新排队原项。
- 单文件上限：后端没有暴露运行时值。前端读 `GET /health` 的 `limits.maxFileBytes`（**待后端支持**），没有就回退到后端代码缺省 100 MiB（`config.js` `KB_MAX_FILE_BYTES`）。已删除旧的 200MB 前端默认值。
- 允许类型：与 `limits.js#ALLOWED` 一致：pdf docx pptx xlsx xls csv html htm md txt png jpg jpeg tif tiff bmp webp。前端本地预检扩展名/空文件/超限，后端仍会校验文件头。TXT 由 worker 本地解析，支持 UTF-8、UTF-16 和 GB18030。
- 每个文件的反馈按后端 code：`duplicate`（去重命中）、`unsupported_type`、`file_too_large`、`empty_file`、`content_type_mismatch`、`too_many_files`、`batch_too_large`、`folder_required`、`missing`（文件夹不存在/无权）、`forbidden`、网络异常、超时、取消。响应同时有 `files` 和 `rejected` 时显示为部分成功。
- 状态：排队中 / 上传中(%) / 已上传·等待解析 / 解析中 / 结构化入库中 / 完成 / 部分完成 / 解析失败 / 失败 / 已取消。上传后的状态只来自 `GET /files?ids=`（每次 ≤50 个；先查当前可见页，再轮转一片其余进行中的项），不在本地伪造。
- 列表每页 50 条，只渲染当前页；队列项不做 Vue 响应式，进度渲染节流 200ms。
- 本地队列是临时的：只在当前页面内存里，刷新、关闭或离开 `/kb` 后不存在。界面上「排队中·未提交」「等待重试·未提交」「失败·未提交」都是本地状态；「已上传·等待解析」之后的状态来自后端。有未提交文件时：`beforeunload` 提示；在应用内离开 `/kb` 时 `KbIndexPage#beforeRouteLeave` 弹确认，确认离开会中止这些上传。已上传的文件在后端继续解析，回到文件管理看到的是后端真实状态。

## 表头与字段映射（第一阶段，2026-10-19）

前端实现：`components/KbHeaderMap.vue` + 纯逻辑 `utils/headerMapping.js`。

- 行号一律是 Excel 中看到的 1 基行号；列 `index` 为 0 基（与 `kb.fields.col_index` 一致）。
- 原始行：先用 `GET /files/:id/layout` 的 `preview`（后端只给前 12 行、80 列，每格截断 80 字）；需要更多行时只读下载 `GET /files/:id/raw`，用现有 `xlsx` 依赖在浏览器内解析（从 A1 开始取，保留合并单元格），不回写任何文件。
- 本地解析的内存保护：整本原文件字节会下载到浏览器；xlsx 解压 + 解析的内存约为文件大小的数倍到数十倍。因此文件超过 20 MB 时不在本地解析（明确提示，只能用后端前 12 行预览）；不超过时只解析当前需要的那一张工作表（`sheets` 选项），最多 20000 行（`sheetRows`），超出部分提示需要后端分页预览。组件销毁或换文件时释放字节。文件过大且工作表已人工确认时，用后端预览值推断上次的人工列名（没有合并单元格信息，可能多标几列为「已保存」，只会原样保留当前名字）。
- 同页的 `KbSourcePreview.vue`（原文预览，非本轮改动）仍会下载并解析整本工作簿再截取 500 行，没有大小保护，是现有内存风险。
- 自动列名按与后端 `combineHeaders` 相同的规则按当前表头行重新推导；用户改过的列名按列号保留，换表头不会被覆盖。已人工确认的工作表，先用原表推导出原始列名，与已保存名字不同的列视为「已保存的人工名称」，重新提交时继续作为 `columnOverrides` 发送。
- 每个工作表独立保存表头行、数据起始行、字段名、是否参与提交、是否已核对。未参与提交的工作表由后端自动检测（之前的人工确认不会保留）。
- 提交前校验全部参与提交的工作表：必须有表头行、表头行不是空行、数据起始行在最后一个表头行之后、行/列在范围内（`rowCount` / `columnCount`）、字段名非空且不超过 200 字、同一工作表内不重名、已勾选核对。任何一项不通过都不发请求。后端对应的 400 码：`bad_layout`、`empty_header`、`bad_column_override`。
- 提交后轮询 `GET /files/:id` 到非进行中，再用 `GET /fields`、`GET /records?limit=1` 的真实结果显示解析版本、字段数、记录数，并用 `currentRunId === runId` 判断本次映射是否成为当前版本。

## 批次任务（第三阶段，2026-10-19）

以 `docs/file-kb/BATCH_API_V2.md` 和 `services/file-kb/src/batches.js`、`api.js#upload` 的实际代码为准。前端：`components/KbBatchDrawer.vue`（列表/详情抽屉）、`KbUploadPanel.vue`（批次上传）、纯逻辑 `utils/batchState.js`。

| 方法 | 路径 | 前端函数 | 请求 | 响应 / 前端用法 |
|---|---|---|---|---|
| POST | /batches | createBatch | `{name,expectedCount}`，1–1000 | 201 批次状态。超出范围 400 `bad_batch_size` |
| GET | /batches | listBatches | `limit≤100&cursor` | `{items:[状态],nextCursor}`。**按 id 游标排序，不是时间**；前端按 `createdAt` 排已加载的项 |
| GET | /batches/:id | getBatch | – | `{id,name,state,control,sealed,total,received,notUploaded,waiting,processing,done,partial,failed,cancelled,completed,progress,createdAt,updatedAt}` |
| GET | /batches/:id/items | listBatchItems | `limit≤200&cursor` | `{items:[kb.batch_items 原始行，snake_case],nextCursor}`。**没有状态过滤** |
| POST | /files?batch_id&client_key | uploadFile | multipart 单文件 | 文件对象另带 `batchId`。409 `batch_closed` / `batch_full` / `client_key_conflict` |
| POST | /batches/:id/{seal,pause,resume,cancel,retry} | batchAction | `{}` | 最新批次状态。409 `batch_cancelled` / `run_superseded` / `job_in_progress` |

状态（后端推导）：`accepting` 接收中·未封口 / `running` 后台处理中 / `paused` / `cancelling` / `done` / `partial` / `failed` / `cancelled`。条目状态：`waiting` / `processing` / `done` / `partial` / `failed` / `cancelled`；`failed` 且没有 `file_id` 显示为「上传失败」。

前端规则：

- **上传**：「作为批次任务上传」默认开启（批次接口可用且不是限定文件夹的令牌）。每次选择的文件去重后建一个批次，计划数 = 去重后的文件数（含本地预检不通过的，它们计入 `notUploaded`），超过 1000 个拆成多个批次。复用原上传队列：每项带 `batchId` 和稳定的 `clientKey`（大小 + 修改时间 + 文件夹 + 文件名），重试、补传都发同一个 key。建批次失败时这批文件改为普通上传，并提示（网络错误时说明可能留下空批次）。
- **封口**：本页属于该批次的文件全部结束后自动封口；仍有可重试的上传失败项时不自动封口，由用户选择「重试」或「封口」。封口失败不自动重发（封口幂等，可手动再点）。计划数没达到也可以封口，批次以 `partial` 结束，不会卡住。
- **与文档不一致之处，以代码为准**：`api.js#upload` 在批次已封口或已取消时一律返回 409 `batch_closed`，包括原本上传失败的 key。所以上传失败项只能在**封口前**重传；封口后前端隐藏这些项的重试按钮，并说明原因。
- **重试**：`POST /retry` 只重新排队有解析任务、非重复的失败项。详情页会扫描失败项（每页 200 条，1000 个条目最多 5 次请求），只有存在可重试项时才显示「重试解析失败项（n）」。
- **补传**：只在未封口、未取消、`received < total` 时可用，用于刷新后本地队列已经没有了的情况。文件上传到当前文件夹。
- **进度**：两条分开。「上传接收」= `received/total`（上传阶段）；「后台处理」= 按 `done/partial/failed/cancelled` 分色堆叠，`completed` 包含失败和取消。没有本地模拟进度。
- **刷新恢复**：抽屉状态放在路由 query（`/kb/files?batches=1` 列表、`?batch=<id>` 详情）。刷新后全部从后端重新读取。本地上传队列只存在于内存，不用于恢复。
- **轮询**：详情每 2–10 秒（指数退避），列表只刷新未结束的批次（每轮最多 10 个，3–15 秒）。终态后停止。页面隐藏时暂停（`kbPolling`）。
- **大批量**：条目按后端游标分页，每页 50 条，只渲染当前页；失败项本地分页，每页 50 条。
- **错误**：429 沿用上传队列的退避（读 `retryAfterMs` / `Retry-After`，有次数和总时长上限）；409 不重试，显示后端错误码对应的文案；批次操作遇到网络错误或 502–504 视为「结果未知」，不自动重发，改为重新读取批次状态。

## 待后端支持 / 尚未统一

| 项 | 现状 | 前端处理 |
|---|---|---|
| 运行时上传限制（maxFileBytes、maxBatchBytes、maxFilesPerBatch、每用户并发、允许类型） | 只在后端 config/limits 里，没有接口 | 读 `GET /health` 的 `limits`（若有），否则用 100 MiB 和上面的类型表 |
| layout 返回 `rowCount` / `columnCount` | 工作区后端已透出（另有 `mappingVersion:2`、`columnsAreSnapshot:true`），运行中的旧容器未必有 | 有就用来校验行/列范围；没有时只在读取原文件后才校验行范围 |
| layout 任意起点预览（如 `from_row`、`limit`） | 没有，只有前 12 行 | 改为只读下载原文件在浏览器解析 |
| 检测原因 `reason` | layout 不返回 | 有就显示；没有时显示「后端未提供检测原因」，不编造 |
| 同一工作表多表格独立映射（structure 请求里的 `table_index` / regions） | structure 每个 sheet 只接受一套表头 | 显示禁用的「按表格区域分别映射（暂不支持）」和说明 |
| 已确认版本原样重提 | `normalizeMappings` 在表头行不变时会把与已保存名字相同的 `columns` 过滤掉 | 前端不用 `columns`，只发 `columnOverrides`，并先从原表推断已保存的人工名称 |
| 封口后重传上传失败项 | `BATCH_API_V2.md` 说可以，`api.js#upload` 实际返回 409 `batch_closed` | 只在封口前允许重传；封口后隐藏重试并说明原因 |
| 批次条目按状态过滤 | `GET /batches/:id/items` 没有 state 参数 | 失败项扫描全部条目后本地过滤（上限 10 页 × 200） |
| 批次列表按时间排序 | 后端按 id 游标排序 | 前端按 `createdAt` 排已加载的项 |
| 429 的 `Retry-After` | 工作区后端对所有 429 固定返回 1 秒，与实际等待时间无关 | 前端取「退避值」和 Retry-After 中较大的一个 |
| 上传幂等 | 只靠 sha256 去重；没有 `Idempotency-Key`，没有按 sha256 查询文件的接口 | 重试安全（不会重复建文件/任务），但无法在重试前确认上次是否已成功 |
| 后端分页的任意行预览 | 没有 | 本地解析有 20 MB / 20000 行上限；超出等待后端 |
