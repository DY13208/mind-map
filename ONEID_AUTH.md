# WorkBuddy / 腾讯 OneID 单点登录

CPD 支持通过腾讯 OneID 的 OIDC 授权码模式建立现有 `mind_map_session` 会话。登录后沿用同一套 API、WebSocket、文件和协作权限保护；企业微信二维码可继续作为回退入口。

## OneID 管理后台

在「自建应用 → 认证配置」中保留 `authorization_code` 和 `RS256`，并配置：

```text
登录回调地址：https://xx.stillgroup.net:8989/api/auth/oneid/callback
登出回调地址：https://xx.stillgroup.net:8989/
```

登录回调必须和 `.env` 的 `ONEID_REDIRECT_URI` 完全一致。Scope 至少需要 `openid profile mobile`；`mobile` 用于把 OneID 成员安全映射回现有企业微信 userid，避免同一成员出现两套 CPD 账号。

## 环境变量

从 OneID 应用详情复制 Client ID、Client Secret 和端点信息到仓库根目录 `.env`：

```dotenv
ONEID_AUTH_ENABLED=true
ONEID_AUTO_LOGIN=true
ONEID_CLIENT_ID=替换为应用Client-ID
ONEID_CLIENT_SECRET=替换为应用Client-Secret
ONEID_ISSUER=https://oauth2.account.tencent.com/authz/oidc/v2/替换为租户ID
ONEID_AUTHORIZATION_ENDPOINT=https://oauth2.account.tencent.com/authz/oidc/v2/替换为租户ID/authorize
ONEID_TOKEN_ENDPOINT=https://oauth2.account.tencent.com/authz/oidc/v2/替换为租户ID/token
ONEID_USERINFO_ENDPOINT=https://oauth2.account.tencent.com/authz/oidc/v2/替换为租户ID/userinfo
ONEID_REDIRECT_URI=https://xx.stillgroup.net:8989/api/auth/oneid/callback
ONEID_SCOPES=openid profile mobile
```

生产环境同时设置：

```dotenv
AUTH_APP_ORIGIN=https://xx.stillgroup.net:8989
AUTH_COOKIE_SECURE=true
```

`ONEID_AUTO_LOGIN=true` 时，未登录的新浏览器标签页会先跳转 OneID。用户已从 WorkBuddy 建立 OneID 登录态时会直接返回 CPD；取消、超时或配置错误时，本标签页只尝试一次，然后显示企业微信二维码和手动 OneID 登录按钮，避免重定向循环。

## 安全与验收

- 授权请求使用数据库保存、十分钟过期且一次性消费的 `state`，并绑定浏览器 Cookie 和认证提供方。
- Client Secret 只在服务端换取 token，不进入前端构建产物、URL 或日志。
- 用户信息通过 OneID `userinfo` 端点读取；优先按手机号确认企业微信 userid，无法映射时使用 OneID issuer + subject 生成稳定隔离账号。
- 登录成功后检查 `/api/auth/me`、受保护 `/api/files` 和协作 WebSocket；退出后这些入口应重新返回未认证。
- WorkBuddy 工作台入口可以保持 `https://xx.stillgroup.net:8989/`。
