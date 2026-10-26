# 文件库免登录直链

文件列表的「更多 → 免登录直链」允许有文件查看权限的登录用户生成链接，无需管理权限。桌面和手机端使用同一入口。有效期可选 1 天、7 天（默认）、30 天或永久；生成者可撤销自己的链接。

链接直接返回原文件，可用于浏览器或其它支持 URL 的客户端。PDF、图片等沿用原文件接口的浏览策略，其它类型按原有规则下载。生成链接不会将文件列表、解析结果或其它文件开放给匿名用户。

后端只存储随机令牌的 SHA-256 哈希，完整链接仅生成时返回，请在生成后复制保存。每次访问都会检查有效期、撤销状态，以及生成者当前的文件查看权限；删除文件或移除生成者查看权限后，链接失效。重新授权后，尚未到期且未撤销的链接可再次使用。网页 HTTP 变更请求仍受原有 Bearer scope 限制，普通查看者的登录会话可直接生成链接。MCP 的 `kb:read` 凭据可调用下述短时下载工具。

## 部署

需一起发布文件库后端和前端。数据库新增迁移 `services/file-kb/src/migrations/010_direct_links.sql`，使用现有迁移机制创建 `kb.direct_links`。`FILE_KB_MIGRATE_ON_START` 默认开启，后端启动时执行迁移；若已关闭，先在文件库服务目录运行 `npm run migrate`。现有 `/api/kb/` 反向代理覆盖公开链接路径，无需增加代理规则。

## MCP 自动获取下载链接

调用 `get_knowledge_download_url({"fileId":"文件 UUID"})` 即可取得原文件地址，无需先在网页手工生成。工具只接受文件 ID；调用者须有文件查看权限，MCP 令牌的文件夹范围同样生效。

返回字段：`fileId`、`fileName`、`mime`、`size`、`linkId`、`downloadUrl`、`expiresAt`。`downloadUrl` 是免登录的原文件地址，最多有效 15 分钟，若来源 MCP 令牌更早到期则相应缩短。撤销或删除来源令牌、移除其读取 scope、删除用户或移除文件查看权限后，后续下载请求失效。生成者也能在网页直链列表中通过对应 `linkId` 撤销。

部署前设置 `FILE_KB_PUBLIC_BASE_URL=https://xx.stillgroup.net:8989`（示例，请使用实际公网源，包含端口，不带路径）。Compose 已向 API 和 MCP 服务透传此变量。不根据客户端提供的 Host 拼接公网地址；未配置或格式不正确时，仅下载工具返回 `download_url_unavailable`，已有工具继续可用。

本功能增加迁移 `011_download_link_source.sql`，需先应用 `010` 和 `011`，并同时更新 `file-kb` 与 `file-kb-mcp` 服务。下载请求由 `file-kb` 服务返回原文件流。

## 验证

- 文件库目录执行 `npm test`，包含通过真实 HTTP 请求与文件流验证的直链测试（数据库使用受控替身）。
- 前端目录执行 `node --test tests/kbDirectLink.test.cjs`，验证有效期传递、链接生成与撤销失败处理。
- MCP 目录执行 `npm test`，通过真实 MCP SDK 获取 URL，并从 HTTP 服务匿名下载并比对原始 PDF 字节（数据库使用受控替身）。
- 真实 PostgreSQL 迁移和部署后的匿名访问需在部署环境验收。
