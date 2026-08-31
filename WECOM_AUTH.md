# 企业微信扫码单点登录

本项目使用企业微信自建应用的 OAuth 扫码登录。登录启用后，文件 API、AI 转发和协同 WebSocket 都要求有效会话；健康检查和 MCP 保持独立，MCP 继续使用 `MCP_TOKEN`。

企业微信官方参考：[构造扫码登录链接](https://developer.work.weixin.qq.com/document/path/91019)、[获取访问用户身份](https://developer.work.weixin.qq.com/document/path/91023)、[获取 access_token](https://developer.work.weixin.qq.com/document/path/91039)。

## 1. 企业微信管理后台

1. 进入 **应用管理**，创建或选择一个自建应用，记录 `AgentId` 和 `Secret`。
2. 将允许使用思维导图的成员或部门加入该应用的可见范围。
3. 在该应用中开启 **企业微信授权登录**，设置授权回调域。
4. 回调域只填域名和端口，不包含协议与路径，并且必须与实际访问地址完全一致。

例如外部回调地址是：

```text
https://mindmap.example.com/api/auth/wecom/callback
```

企业微信后台的授权回调域填写：

```text
mindmap.example.com
```

如果实际使用非标准端口，例如 `https://mindmap.example.com:8443`，后台也必须填写 `mindmap.example.com:8443`。不支持通配域名。

## 2. 项目配置

复制 `.env.example` 为 `.env`，保留原有 PostgreSQL 和 COS 配置，再填写：

```dotenv
WECOM_AUTH_ENABLED=true
WECOM_CORP_ID=wwxxxxxxxxxxxxxxxx
WECOM_AGENT_ID=1000002
WECOM_SECRET=替换为自建应用Secret
WECOM_REDIRECT_URI=https://mindmap.example.com/api/auth/wecom/callback
# 可选，只接受 HTTPS；用于覆盖企业微信内嵌二维码默认样式
WECOM_QR_STYLE_URL=https://static.example.com/wecom-login.css
AUTH_APP_ORIGIN=https://mindmap.example.com
AUTH_SESSION_SECRET=替换为至少32字符的随机密钥
MCP_TOKEN=替换为另一个至少32字符的随机令牌
AUTH_SESSION_TTL_HOURS=168
AUTH_SESSION_MAX_HOURS=720
AUTH_COOKIE_SECURE=true
```

分别生成会话密钥和 MCP 令牌：

```bash
openssl rand -hex 32
openssl rand -hex 32
```

`AUTH_APP_ORIGIN` 是用户实际打开网页的源，只能包含协议、域名和可选端口。Docker 网关和页面同域时可以留空，程序会从 `WECOM_REDIRECT_URI` 推导。

未登录时页面会直接加载企业微信内嵌二维码，不需要先点登录按钮。二维码对应的 OAuth `state` 有效期为 10 分钟，页面会在失效前 30 秒自动生成新二维码，同时保留手动刷新入口。`WECOM_QR_STYLE_URL` 使用企业微信官方 `href` 能力覆盖二维码样式，因此必须是公网可访问的 HTTPS CSS 地址；仓库中的 `web/public/wecom-login.css` 可用于隐藏二维码下方的应用名称。

本地 Node 跨端口开发时，页面通常在 `8081`，认证 API 在 `1234`，因此需要显式设置，例如：

```dotenv
WECOM_REDIRECT_URI=http://192.168.1.20:1234/api/auth/wecom/callback
AUTH_APP_ORIGIN=http://192.168.1.20:8081
AUTH_COOKIE_SECURE=false
```

企业微信后台授权回调域同时填写 `192.168.1.20:1234`。正式环境应使用固定域名和 HTTPS，不要依赖会变化的局域网 IP。

## 3. 启动和验收

Docker 模式：

```bash
node scripts/docker-up.js
```

检查网关和认证状态：

```bash
curl -fsS https://mindmap.example.com/health
curl -fsS https://mindmap.example.com/api/auth/config
curl -fsS https://mindmap.example.com/api/auth/me
```

预期结果：

- `/health` 返回 `ok: true`；
- `/api/auth/config` 返回 `enabled: true`；
- 未登录的 `/api/auth/me` 返回 `authenticated: false`；
- 未登录直接访问 `/api/files` 返回 HTTP 401；
- 浏览器打开页面后直接显示企业微信登录二维码，扫码确认后回到原页面；
- 点击“刷新二维码”会生成新的二维码；持续停留时会在二维码失效前自动更新；
- 再次刷新不要求重复扫码，协同连接和文件列表正常；
- 点击右上角“退出”后，文件 API 和协同连接重新变为未授权。

## 本地开发者密钥登录

本地或内网调试时，企业微信二维码往往无法扫码或回调域名不匹配。可在 `.env` 配置 `AUTH_DEV_BYPASS_KEY`（至少 32 字符）后，登录页会出现 **开发者密钥登录** 入口，输入同一密钥即可模拟成员会话，无需扫码。

限制：

- 仅在 **localhost / 127.0.0.1 / 内网 IP** 访问时生效；公网域名默认不可用。
- 必须同时启用 `WECOM_AUTH_ENABLED=true`；生产环境不要配置该密钥。
- 如需在公网域名调试（不推荐），需额外设置 `AUTH_DEV_BYPASS_ALLOW_PUBLIC=true`。
- 可选 `AUTH_DEV_BYPASS_USER_NAME`、`AUTH_DEV_BYPASS_USER_ID` 自定义模拟成员信息。

```dotenv
AUTH_DEV_BYPASS_KEY=请替换为至少32字符的随机串
AUTH_DEV_BYPASS_USER_NAME=本地开发者
```

生成密钥示例：`openssl rand -hex 32`

## 稳定性与安全边界

- OAuth `state` 使用随机数、HMAC 签名、浏览器绑定和 PostgreSQL 一次性消费，10 分钟过期。
- 企业微信 `access_token` 在服务端缓存并提前 5 分钟刷新；明确返回令牌失效时只刷新重试一次。
- 登录会话只在浏览器保存随机令牌，数据库只保存 SHA-256 哈希；默认 7 天滑动有效、最长 30 天。
- Cookie 使用 `HttpOnly`、`SameSite=Lax`，HTTPS 下使用 `Secure`。
- Nginx 访问日志不记录查询字符串，避免回调中的短期 `code` 和 `state` 落入日志。
- 企业微信 `Secret` 和会话密钥只放 `.env`，不要提交到 Git。
- 登录启用时强制要求独立的 `MCP_TOKEN`；MCP 服务用它访问内部文件 API，外部 MCP 客户端也必须携带同一 Bearer Token，不会绕过登录保护。
- PostgreSQL 不可用、配置缺项或配置格式错误时，启用认证的服务会启动失败，不会降级成免登录。
