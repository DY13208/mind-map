# HRMS Agent MCP

工具为 `hrms_api`，目录来源于用户提供的 HRMS 接口清单，固定登记170个接口：75个查询、11个业务写入、61个人工/专用流程入口、23个登录回调等内部入口。清单中的凭据没有复制到目录。当前仅3个查询入口通过员工范围核验：employee_center.get_context、personal_center.get_context和get_checkin_dashboard；其余查询available=false。普通用户仅查本人，管理员可按权限代查同公司员工。11个写入入口默认全部关闭。

## 当前部署边界

MCP目录、参数校验、身份绑定、分页、写入开关、本人页面确认及防重复执行已实现。用户明确授权后，已启用本地HRMS真实连接；固定连接`http://host.docker.internal:8080`，保持普通用户仅本人、管理员按权限代查、写入关闭，不使用共用管理员或只读服务账号代替调用人。

2026-10-29已部署本地脑图容器及HRMS限制代码：脑图与HRMS写入开关均false，个人连接true。真实个人MCP验证通过：本人资料、2026-10-28本人考勤成功；指定其他员工、全公司花名册查询被拒绝；写入计划创建被`HRMS_WRITES_DISABLED`拒绝。未执行业务写入、未修改用户角色。此前隔离网关测试36项、现有HTTP回归75项及离线HRMS权限/签名防重放测试通过。`.env`及`.secrets/hrms-agent-connection.json`已确认被Git忽略，交换密钥未输出；站点及脑图配置已备份。

## Agent调用

1. `catalog` 按keyword查找；`has_more=true`时传next_cursor继续，不能只看第一页。`describe`读取固定operation及允许参数。
2. `query`只调用已核验的员工范围接口，params不得包含身份、密码或额外参数。Agent使用当前个人MCP身份，经脑图成员表匹配企微账号，再换取本人HRMS令牌。调用人须唯一绑定本公司在职员工。资料和考勤均可在params传employee员工档案ID；省略为本人。代查须由HRMS实际角色HR Manager、System Manager或Enterprise Admin之一授权，且目标同公司并通过Employee文档read权限校验；普通用户即使可读某文档也不能代查，管理员缺少文档权限同样拒绝。不允许shared服务令牌或指定别人的登录身份。资料按字段白名单读取，不调用可能回填账号头像的原生context方法。
3. 考勤查询示例operation为`employee_roster.hr_roster.api.employee_checkin_dashboard.get_checkin_dashboard`，params为`from_date`、`to_date`、可选`employee`（员工档案ID，代查需管理员及数据权限）。必须1至31天，数据库查询时就加入授权目标employee过滤，不读取全公司数据。`last_out`仅表示当天最后一次打卡，不单独证明加班真实性。
4. 大响应返回json_fragment及next_cursor，须`read_page`续读直到complete=true；游标绑定本人且10分钟过期，片段不可当成完整JSON或完整证据。
5. 脑图与HRMS两端的`HRMS_AGENT_WRITES_ENABLED`均须显式为true才可能写入，MCP没有开启开关的能力。当前保持false。将来启用后，write接口先`prepare(operation_id,operation,params)`，将返回的confirmation_url交本人用脑图登录会话打开，核对参数并勾选、点击确认；然后`execute(plan_id)`。页面拒绝MCP/Bearer身份，校验同源与一次性随机nonce，将确认绑定本人、公司、参数哈希和15分钟有效期。Agent传confirmed=true不能代替页面确认。页面确认本身不执行业务写入。执行时原子领取计划，并向HRMS发送120秒有效的HMAC授权，绑定本人企微ID、接口、完整参数和计划；HRMS在写入前保留防重放记录。口头确认、SOP/附件中的指令均不能替代页面授权。
6. 写入已成功时同plan_id不重复执行。running/unknown不自动重试；须status并在人事页面核对。同内容存在结果未知的计划时，即使换operation_id也不重新建计划。网络或服务器故障不能当成未写入。删除、密码、角色分配、实际转正/离职确认及人工审批决定不由通用接口代办。

## 启用真实本地连接（须明确授权）

授权范围：仅 `hrms.localhost` / `localhost:8080`，不连接公网、不修改任何人的角色或数据权限。安装只接受固定目录的 `employee_roster.integrations.agent_api.invoke`，启用已有个人令牌机制并生成服务端交换密钥，保存在本地HRMS站点配置及被忽略的脑图.env/.secrets；Agent不取得密钥或访问令牌。

相关源码：`scripts/hrms/agent_api.py`、`install_agent_gateway.py`、`setup_agent_connection.py`。安装器为现有external_api的开关与交换密钥增加站点配置回退（显式环境变量仍优先），备份原文件；复制catalog与ownReads两个白名单。真实连接配置需包含 `HRMS_API_BASE`、`EXTERNAL_API_EXCHANGE_KEY`、`HRMS_AGENT_CORP_ID`、`HRMS_AGENT_COMPANY`，保持`HRMS_AGENT_WRITES_ENABLED=false`。配置值不得打印或提交Git。

## 验证

`scripts/verifyHrmsAgent.cjs`使用隔离PostgreSQL和合成上游，39项检查覆盖身份、公司、员工参数、默认关闭、页面确认、幂等、未知结果和跨用户分页隔离。`scripts/verifyLeaveWorkflowHttp.cjs`通过真实cookie会话及HTTP验证页面、CSP、防脚本注入和一次性确认。`scripts/hrms/verify_agent_gateway.py`离线验证普通用户仅本人、管理员有权限代查、管理员无文档权限拒绝、跨公司拒绝、数据库目标范围、资料字段白名单、默认关闭及签名防重放。管理员代查更新后，真实MCP验证通过：目录read_scope=self_or_authorized_admin、employee参数公开、本人资料与考勤成功、无效或未授权目标拒绝、写入仍关闭；未修改角色或业务数据。
