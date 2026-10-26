# WorkBuddy 扫码领取 mind-map MCP 配置

将 MCP 接入页的「复制 WorkBuddy 接入指令」发给用户本机 WorkBuddy。
指令只含服务地址，不含个人 key。WorkBuddy 创建请求并提供链接与确认码；
用户打开链接，经现有企业微信登录后核对确认码并点击确认。
WorkBuddy 轮询领取配置，合并本机 MCP 文件并验证连接。

## 接口

- `POST /api/mcp-config/device`：无需登录，返回 `device_code`（仅客户端保管）、
  `user_code`（核对用）、`verification_uri`、`poll_uri`、`expires_in: 300`、`interval: 3`。
- `GET /api/mcp-config/device/authorize?request_id=...`：未登录时跳转企业微信登录；
  已登录时显示账号、确认码与授权范围。GET 不授权，不返回 key。
- `POST /api/mcp-config/device/authorize?request_id=...`：浏览器表单提交与当前账号
  绑定的 nonce，确认授权。服务身份禁止领取。
- `POST /api/mcp-config/device/poll`：JSON 请求体 `{"device_code":"..."}`。
  每三秒最多一次。未确认返回 202 `authorization_pending`；过快返回 429 `slow_down`；
  过期、无效或已领取返回 400 `invalid_or_expired_code`。
  成功返回 200 `{"mcpServers":{"mind-map":{"type":"http","url":"当前服务地址/mcp",
  "disabled":false,"headers":{"Authorization":"Bearer 个人凭证"}}}}`。

领取凭证与浏览器链接相互独立，五分钟有效，配置只能领取一次。
不要输出领取凭证或 Authorization 到聊天、日志、命令行参数或 Git。
取得 key 不会扩大账号的脑图权限。创建请求每个直连来源每分钟最多 20 次，
同时最多保存 1000 个请求；额度用完返回 429 `too_many_requests`。

授权请求保存在 collab 服务内存中，重启后需重新创建请求。
多实例部署需将创建、授权和轮询路由到同一实例，或后续改用共享存储。
沿用网关的转发域名和协议生成地址，网关应覆盖客户端传入的转发头。
需要部署新代码并重启 collab 服务；本机 WorkBuddy 需要能访问该服务地址。

## MCP 工具说明刷新与批量写入

工具说明或参数 schema 更新后，本机 WorkBuddy 应先断开并重新连接 MCP，重新读取工具定义。若当前会话仍展示旧定义，再重启 WorkBuddy 或新建会话。通常无需更改服务地址、个人凭证或权限；刷新客户端只更新工具定义，不会改变服务端能力开关。

修改节点文字、备注或链接时，从 `query_nodes` 本次返回的数据取得字段版本，并将 `uid` 和字段版本放进 `expected`。例如文字版本 `data.__fv.text=12` 对应 `{"uid":"node-123","__fv.text":12}`；`"__fv.text"` 是完整 JSON 键名，不应写成嵌套 `__fv` 对象。查询顶层 `version` 是房间修订号，不能替代字段版本。`include_write_hints: true` 可请求查询结果附带可复制的 `write_hints.update` 条件；默认不开启，旧请求保持兼容。

多节点意图使用一次 `apply_nodes` 批量提交，每批最多 100 项。该能力要求 V2、事件桥、MCP Direct 与房间节点表同时就绪。环境不满足时，legacy 通道不支持 `node.batch`；Agent 应报告能力错误和可用的 `details.fallbackReason`，不得改用循环单项调用。

失败时检查 `code`、`statusCode`、`details.fallbackReason`、`outcome` 和 `outcomeUnknown`。MCP 外层 HTTP 200 不等于节点写入成功，`writeSubmitted=true` 也不表示已落库。`PRECONDITION_REQUIRED`（428）和 `REPLACE_CONFLICT`（409）须报告并等待用户后续指示，不自动换成最新字段版本重试。结果未知时，使用原操作 ID、原内容和原修订号核验。

服务端启用批量写入需要先验证事件桥，再启用 Direct，并在隔离房间验收；更新客户端说明不会启用这些开关。远端发布、重启和开关调整另行安排。本文件描述 WorkBuddy 领取配置流程，不替代服务端部署与运行状态核查。
