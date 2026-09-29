# WorkBuddy OAuth 单点登录

这里接入的是 WorkBuddy 自己的 OAuth 2.0 / OIDC，不是腾讯 OneID 认证源。

正确链路：

1. 用户已经登录 WorkBuddy。
2. CPD 将浏览器跳转到 WorkBuddy 授权端点。
3. WorkBuddy 使用现有登录会话签发一次性授权码。
4. CPD 后端交换令牌并读取用户身份。
5. WorkBuddy 的稳定身份标识被绑定到现有企业微信成员，继续使用同一个内部用户 ID、文件、团队和权限。

## WorkBuddy 后台

应用重定向 URI 必须逐字配置为：

```text
https://xx.stillgroup.net:8989/oauth/callback
```

授权类型需要包含 `authorization_code`。登录只请求 `openid`，不需要 OneID 的 `profile mobile`。

## 生产环境变量

```dotenv
WORKBUDDY_AUTH_ENABLED=true
WORKBUDDY_CLIENT_ID=从应用详情复制
WORKBUDDY_CLIENT_SECRET=创建或重置应用密钥时保存的值
WORKBUDDY_REDIRECT_URI=https://xx.stillgroup.net:8989/oauth/callback
WORKBUDDY_AUTHORIZATION_ENDPOINT=https://www.workbuddy.cn/oauth2
WORKBUDDY_TOKEN_ENDPOINT=https://www.workbuddy.cn/oauth2/token
WORKBUDDY_USERINFO_ENDPOINT=https://www.workbuddy.cn/oauth2/userinfo
WORKBUDDY_SCOPES=openid
WORKBUDDY_AUTO_LOGIN=false
```

同时保持原企业微信配置不变。当前建议 `WORKBUDDY_AUTO_LOGIN=false`，登录页由用户自行选择企业微信扫码或 WorkBuddy。OAuth 失败返回后不会自动循环，页面仍保留企业微信扫码入口。

旧的 `ONEID_*` 配置是另一套腾讯 OneID 身份源。切换到 WorkBuddy OAuth 后应设置：

```dotenv
ONEID_AUTH_ENABLED=false
ONEID_LOGIN_READY=false
ONEID_AUTO_LOGIN=false
```

## 同账号保证

首次登录优先使用 WorkBuddy 用户信息里的企业微信 userid 或手机号匹配现有成员。若 WorkBuddy 仅返回 `openid` 等不含可核对成员信息的标识，系统不会按昵称猜测：用户先扫码登录原企业微信账号，随后在页面提示中点击“验证并绑定”，再次完成 WorkBuddy 授权。两边均验证通过后，只保存 WorkBuddy subject 的哈希与原内部用户 ID 的绑定。此后 WorkBuddy 单点登录会沿用原账号、文件、团队和权限。

当无法确认是同一个成员时，系统会返回 `workbuddy_account_not_linked`，不会自动新建第二套账号。绑定时必须保留有效的企业微信登录会话；一个 WorkBuddy 身份不能被静默改绑到其他成员。如果 WorkBuddy 返回的企业微信成员信息与当前会话冲突，也会拒绝绑定。
