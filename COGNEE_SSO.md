# Cognee 使用 mind-map 企业微信登录

本项目提供 `/api/auth/cognee/authorize` 和 `/api/auth/cognee/exchange`，让 Cognee 复用现有企业微信扫码/客户端登录。已登录用户直接返回 Cognee，未登录用户先经过原企业微信登录。企业微信应用配置与原回调地址无需复制或改动。

在本项目部署 `.env` 增加：

```dotenv
MIND_MAP_COGNEE_SSO_SECRET=<新生成的至少 32 字符随机密钥>
COGNEE_SSO_REDIRECT_URI=https://xx.stillgroup.net:3030/sso/mind-map/callback
```

Cognee 后端配置相同共享密钥及以下变量：

```dotenv
MIND_MAP_SSO_ENABLED=true
MIND_MAP_SSO_ORIGIN=https://xx.stillgroup.net:8989
MIND_MAP_SSO_REDIRECT_URI=https://xx.stillgroup.net:3030/sso/mind-map/callback
MIND_MAP_COGNEE_SSO_SECRET=<相同共享密钥>
ENABLE_BACKEND_ACCESS_CONTROL=true
REQUIRE_AUTHENTICATION=true
```

Cognee 会沿用已启用 WorkBuddy 的会话签名配置；没有 WorkBuddy 时必须另外配置 `MIND_MAP_SSO_SESSION_SECRET`（至少 32 字符且不同于共享密钥）。完整配置及更新、验收步骤见 [Cognee 配置文档](https://github.com/DY13208/cognee/blob/main/docs/mind-map-wecom-sso.md)（合入代码后可用）。

重建、更新 mind-map app 后，认证初始化会建立 `auth_cognee_codes` 表。带 Wiki 的部署必须继续使用原部署配置并保留 `.secrets/wiki.env` 注入。不要用缺少 Wiki 密钥的 Compose 命令重建 app。其余域名、服务端口和已有认证方式无需修改。

授权码有效期 90 秒，必须经过固定 HTTPS 回调、浏览器状态与 S256 PKCE 校验，后台持相同共享密钥才能兑换。数据库只存哈希，原子消费防止重复和并发兑换，支持多进程和服务重启。企业微信凭据仍仅由 mind-map 管理。

测试（`simple-mind-map` 目录）：

```bash
node test/cogneeSso.test.js
node test/cogneeSso.pg.test.js
npm run test:auth
```

PostgreSQL 测试使用当前 `.env` 的 PG 连接，但仅在随机临时 schema 内运行并最终删除，不修改已有账号、会话或业务数据。线上验收需分别完成已登录 mind-map 的直接进入与未登录用户的扫码回跳。
