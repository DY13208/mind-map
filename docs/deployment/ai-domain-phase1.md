# 第一阶段：脑图迁移到 ai.stillgroup.net

目标地址：`https://ai.stillgroup.net:8989`。两个域名继续指向同一公网 IP，公网端口仍转发到原服务器。迁移访问入口、脑图/节点分享、脑图 MCP 与前端配置、企业微信登录和主站 TLS；Wiki、Cognee、HRMS、小策及其他登录提供方的独立域名留到第二阶段。

## 1. 配置与证书

1. 备份服务器现有 `.env`（备份仍需保密），将同目录 `ai-domain-phase1.env.example` 的第一阶段字段合并进去。保留所有其他字段和现有内网来源。不要用示例覆盖整个 `.env`。
2. `AUTH_APP_ORIGIN` 必须含 `https://` 和 `:8989`，不含路径。后端分享链接和启动脚本生成的 `.mcp.json` 从它获取公网协议、域名、端口。内部服务仍走原地址。
3. 显式保留服务器现有 `DOCMOST_APP_URL`，防止启动脚本按新 `PUBLIC_HOST` 自动迁移 Wiki。其他系统回调、上游地址、凭据保持原值。
4. 从提供的证书包中取 `ai.stillgroup.net_bundle.crt`，部署为 `certs/ai.stillgroup.net.crt`；私钥部署为 `certs/ai.stillgroup.net.key`。证书 SAN 是 `ai.stillgroup.net`，有效期为 2026-11-02 12:00 UTC 至 2027-01-31 11:59:59 UTC，已验证证书与私钥匹配。私钥权限限制为部署用户可读，不提交 Git，也不放入镜像构建上下文。
5. 保留已有 `certs/xx.stillgroup.net.crt` 和 `.key`。TLS SNI 分别加载两套证书；旧主站页面/分享暂时 302 到新地址，保留路径和查询串。旧 API、MCP、协作和集成路径继续反代，避免跨域重定向丢失 POST/Authorization。旧独立端口（Wiki 3040、Cognee 3030 等）未修改。
6. `docker/tls/proxy.conf` 是新增的共享代理配置，必须和 compose 文件一起更新。
7. 若 `WECOM_QR_STYLE_URL` 当前使用旧主站域名，可改成 `https://ai.stillgroup.net:8989/wecom-login.css`；为空则保持为空。

## 2. 企业微信后台

在现有自建应用中修改：

- 应用主页/桌面端主页（若配置）：`https://ai.stillgroup.net:8989/files?shell=full`。
- 企业微信授权登录 → Web 网页授权回调域：`ai.stillgroup.net:8989`。
- 网页授权及 JS-SDK → OAuth 网页授权可信域名：匹配新回调域，按后台要求完成域名归属验证；JS-SDK 可信域名在实际使用时同步登记。
- 完整回调是 `https://ai.stillgroup.net:8989/api/auth/wecom/callback`，不要把协议和路径填进“回调域”字段。

企业和应用未变，CorpID、AgentId、Secret、成员可见范围继续沿用；公网出口 IP 未变时无需因域名变化修改可信 IP。新域名 Cookie 独立，需要重新登录。迁移后从新主站发起新扫码，不复用旧二维码或尚未完成的登录流程。

## 3. 更新与启动

在服务器项目根目录执行（只重建脑图 app，只重建相关容器）：

```sh
docker compose build app
docker compose run --rm --no-deps tls nginx -t
docker compose up -d --no-deps --force-recreate app tls
```

如果现有部署使用额外 compose 文件或启动器，沿用原部署方式并保留相同的 compose project；不要另起一个项目。修改 `.env` 后仅 `restart` 不会更新已有容器的环境变量，必须 recreate。

前端在新域名下运行时，MCP 接入页中的服务地址、完整 JSON、WorkBuddy 接入指令、节点短链接和节点分享使用新域名。反代路径（包括 `/mcp`、`/knowledge-mcp/mcp`、`/file-kb-mcp/mcp`）沿用现有路由；这不迁移 Wiki 等服务自己的网页域名。已安装客户端不会被网页自动修改，需从新 MCP 接入页复制配置后更新并重新连接。保留其他 MCP 项目及个人 Authorization；不要把令牌粘进聊天或提交 Git。

## 4. 验收与边界

- 新域名证书有效，`/health` 和 `/api/health` 正常；HTTP 打到 TLS 端口时跳转至新 HTTPS 入口。
- 新扫码、企业微信内打开、刷新登录态、退出登录正常；登录后列表及协作正常。
- 复制脑图分享/节点分享/节点短链接，确认域名、HTTPS、8989 端口及 room/uid/token 不丢失，并用具备权限的账号打开。
- MCP 接入页的地址、完整配置、WorkBuddy 指令一致；新客户端 initialize、tools/list、只读工具可用，原个人权限不变。
- 旧域名页面/分享跳到新地址；旧 API/MCP 请求继续转发。Wiki、Cognee、HRMS 等入口保持原地址。
- 本地测试不能替代企业微信后台保存、服务器证书安装和真实公网扫码；上线后必须完成这些验收。

已存进脑图正文、消息或外部系统的绝对旧链接不会批量改写。主站旧链接通过兼容入口处理；第二阶段再处理其他系统。

## 回退

恢复原 `.env` 和原 TLS 配置，移除新增 proxy.conf 挂载后重新创建 app/tls。保留数据库、数据卷、所有凭据与两套证书。第一阶段不执行数据迁移或批量改写。
