# File KB 认证与安全边界

## 1. 现有机制（核对 simple-mind-map/bin/auth.js @1caebf9a）
- Cookie：`mind_map_session`（随机 token，长度 ≤256）。
- 表 `public.auth_sessions(token_hash pk = sha256(token), user_id → wecom_users ON DELETE CASCADE, created_at, last_seen_at, expires_at, absolute_expires_at)`，由 app `initAuth()` 建表。
- 校验 `authenticateRequest()`：`UPDATE auth_sessions ... WHERE token_hash=$1 AND expires_at>now() AND absolute_expires_at>now()`，同时滑动续期 `expires_at = least(absolute_expires_at, now()+TTL)`，并 join `wecom_users`。
- `GET /api/auth/me`：存在。auth 关闭时返回 `{enabled:false, authenticated:false}`；开启时**总是 200**，`{authenticated:bool, user|null, ...登录配置}`（没有登录也是 200，不能只看状态码）。另有 `/api/auth/check`（未登录 401）。
- 登出 `POST/GET /api/auth/logout`：`DELETE FROM auth_sessions WHERE token_hash=...` 并清 cookie → **服务端吊销即删行**。
- 过期清理：登录/OAuth 流程中 `delete from auth_sessions where expires_at<=now() or absolute_expires_at<=now()`。
- 用户禁用/权限撤销：**当前没有 disabled/status 列**。唯一的“吊销”手段是删除会话行，或删除 `wecom_users` 行（级联删会话）。超管来自 env `MIND_MAP_SUPER_ADMIN_IDS`。
- 服务凭据：`MCP_TOKEN` / MCP user token 在 app 中可绕过会话；**file-kb 不接受这些**（KB 的 MCP 在阶段 6 用自己的 `kb.mcp_tokens`）。

## 2. File KB 采用的方式
**只读 SELECT 会话表**（不调用 /api/auth/me）：
```sql
select s.user_id, s.expires_at, s.absolute_expires_at, u.corp_id, u.name
from public.auth_sessions s join public.wecom_users u on u.user_id = s.user_id
where s.token_hash = $1 and s.expires_at > now() and s.absolute_expires_at > now()
```
- 授权（scripts/file-kb/bootstrap.sql）：kb_app 对 `auth_sessions(token_hash,user_id,expires_at,absolute_expires_at)` 与 `wecom_users(user_id,corp_id,name)` 仅有**列级 SELECT**；对 public 无任何写/CREATE；kb_app 为 NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOBYPASSRLS，连接上限 20。
- 选它而不是 HTTP 调 /api/auth/me 的原因：不增加 app 负载/耦合；app 宕机时 KB 仍可鉴权；不需要改 collabServer。
- 不滑动续期（不写 last_seen_at/expires_at）。用户在 KB 页面时外壳页仍会请求 app 接口而续期；若只调用 KB API 超过会话 TTL，会话会按 app 规则过期 → 401。

## 3. 缓存与吊销窗口
- 默认 `FILE_KB_AUTH_CACHE_TTL_MS=0`。每一次请求都重新读取 `auth_sessions`，登出删除会话行后，下一次 API 调用立即 401。
- 配置成大于 0 时，只允许非正文接口复用成功结果，硬上限仍是 30 秒，且不会超过会话自身的 expires_at。文件原文（`/content`）、解析块（`/blocks`）、结构化记录（`/records`）始终传 `fresh: true`，不读、不写这份缓存。
- File KB MCP 没有会话缓存。`/mcp` 每次都执行同一条 SELECT；会话行删除后下一次调用返回 401。MCP 工具本身尚未实现。
- 这只解决会话吊销。`kb.acl` 仍只有 viewer/editor，文件四级权限、文件夹继承和团队授权都还没做。
- DB 不可用：fail-closed，返回 503 `auth_unavailable`，不放行。

## 4. 绝不信任客户端
- 身份只来源于 cookie → DB；`X-User-Id`、`X-Kb-User` 等头被忽略（nginx 也将其清空）。
- 非 GET/HEAD/OPTIONS 请求如带 Origin，必须与 Host/X-Forwarded-Host 同源，否则 403（与 app 的 origin 检查一致）。
- file-kb 只在 compose 内网 `expose 18800`，不映射宿主端口；外部只能经 nginx `/api/kb/`。
- app 的 `AUTH`（企业微信等）未启用时，app 视所有人为已登录；**file-kb 不跟随**，没有有效会话一律 401（不提供匿名模式）。

## 5. 已知边界 / 后续
- 团队成员关系（ACL 用）需要对 teamSpace 表的只读授权，阶段 5 再按实际表名补到 bootstrap.sql。
- 超管判定：读取同一 env `MIND_MAP_SUPER_ADMIN_IDS`。
