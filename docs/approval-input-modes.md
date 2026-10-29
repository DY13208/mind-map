# 审批材料的两种入口

脑图节点定义字段、审核要点、审批人与抄送人；执行以当前已发布的版本为准。

## 脑图入口

`approval_request prepare`使用`input_mode=node`、`use_source_node=true`、原节点room_key/node_uid及template_source。材料填写在原流程的提交要求中，随后import核对。提交携带expected_node_hash、expected_revision、operation_id、expected_definition_version及confirm_submission。

## Agent对话入口

先template核对已发布版本与字段；prepare传`input_mode=agent`、template_source、expected_definition_version、fields。room_key/node_uid可省略，默认引用模板来源；不能同时use_source_node=true。

fields的键可以是模板字段key或准确的字段名称；文本、金额、日期用字符串，附件字段用已授权且可核验的服务器附件ID数组。未提供的字段保持空值，返回validation.missing，不能借用脑图中的示例值。引用不存在、其他申请或越权的附件会被拒绝；文件名不能代替附件。当前沿用已有附件登记渠道，不接收MCP内的本地文件路径或文件正文。

补充材料用save，携带完整fields、input_mode=agent、expected_revision和唯一operation_id。返回新的validation.inputHash。Agent模式不允许import或以nodeSource切换来源。

向用户展示本次字段、附件、实际审核人和抄送人并取得明确提交确认后，submit携带input_mode=agent、request_id、expected_revision、expected_input_hash（最新validation.inputHash）、expected_definition_version、operation_id和confirm_submission=true。不要在submit中夹带新fields；修改须先save、重新核对。资料、附件、人员或发布版本变化会阻止旧确认提交。

## 存储与权限

两种入口可保留各自的在途申请，材料与状态不混用。Agent申请仅存入审批记录和事件快照；创建、修改、提交、审核、投影均不写回脑图。原模板只需可读权限即可在Agent申请，材料维护和提交要求本人个人MCP身份，人工审核仍由实际审核人在页面办理。

Agent材料仍执行相同的必填、格式、附件、组织人员、人工审批、抄送与HRMS同步规则。修改申请材料不等于修改已发布规则；规则编辑后须重新发布，旧版本不能执行。首次Agent prepare重放返回原在途申请，不用新输入静默覆盖；核对返回的request_id、fields后使用save更新。
