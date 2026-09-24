# Yiran API on the mind-map Docker gateway

Mind-map keeps a **single public port** (`MIND_MAP_PORT`, default `8080`).
Yiran (Liangce / 小策 Django) runs as a sibling Compose service and is reached
only through the gateway prefix `/yiran/`.

**Transition model:** WorkBuddy is **not** removed. In the editor settings you
choose **WorkBuddy** or **小策** as the AI backend. Both stay available.

| Path | Service |
|------|---------|
| `/` | Mind-map SPA |
| `/api/*` | Mind-map collab / files |
| `/yiran/*` | Yiran Daphne (prefix stripped → upstream `/…`) |
| `/wb-api/*` | Host WorkBuddy (`host.docker.internal:3000`) |

## Prerequisites

1. Local Yiran checkout (not vendored into this repo), default:
   `C:/Users/YiRan/IdeaProjects/yiran`
2. A **local copy** of that checkout’s `.env` as mind-map **`.env.yiran`**
   (gitignored). Compose loads it first via `env_file`.
3. Docker Desktop with Compose v2
4. WorkBuddy on the host still listens on `:3000` if you use the WorkBuddy
   backend (SOP / fill / expand)
5. The same WeCom member must already have a `matched` binding in Yiran.

## Configure

Copy Yiran env once (or whenever you change agent/LLM/DB secrets):

```bat
copy C:\Users\YiRan\IdeaProjects\yiran\.env .env.yiran
```

In mind-map `.env` (see `.env.example`):

```env
YIRAN_ROOT=C:/Users/YiRan/IdeaProjects/yiran
# Keep using the real Liangce Postgres from .env.yiran (default):
YIRAN_SKIP_CREATEDB=1
```

Optional gateway-only overrides in compose (do not replace `.env.yiran`):

- `YIRAN_DJANGO_ALLOWED_HOSTS`
- `SECURE_SSL_REDIRECT=false` (forced for HTTP gateway)
- `YIRAN_DOTENV_AUTOLOAD`

## Start

```bat
start-with-yiran.bat
```

Or:

```bash
docker compose up -d --build
```

## Frontend: choose backend

1. Open mind-map → Settings → enable AI
2. **AI 后端**: WorkBuddy | 小策
3. If 小策: paste Liangce API Token, refresh model list, pick a model

Calls go to `/wb-api` or `/yiran/api/agent/…` accordingly.

For Xiaoce, Settings also provides an **organization → enterprise agent**
selector. The selection is request-scoped: it does not change Yiran's global
primary organization, so different browser tabs can safely use different
organizations. Agent chat sessions are checked against user + organization +
agent on every request.

## User association / SSO

When the legacy token field is empty, the browser uses the current Mind-map
WeCom session automatically:

1. Mind-map issues a 90-second, one-time signed identity assertion.
2. Yiran resolves the existing binding by `(corp_id, wecom_userid)` only.
3. Yiran returns a 15-minute access token kept in JavaScript memory and renewed
   automatically. It is never persisted to localStorage.

`start-with-yiran.bat` creates `MIND_MAP_YIRAN_SSO_SECRET` in the gitignored
root `.env` when missing and Compose injects it into both services. A missing
binding returns `WECOM_NOT_BOUND`; the bridge never links users by name, phone,
or email and never creates a Yiran user implicitly.

Local developers: set `AUTH_DEV_BYPASS_MOBILE` to your WeCom directory mobile.
Dev-login then resolves the real `wecom_userid` via WeCom API so Xiaoce SSO can
match an existing binding. Do not rely on the default `AUTH_DEV_BYPASS_USER_ID=dev-local`.

## Verify

```bash
curl http://localhost:8080/health
curl http://localhost:8080/api/health
curl http://localhost:8080/yiran/api/schema/
curl http://localhost:8080/wb-api/health
```

Swagger UI: `http://localhost:8080/yiran/api/docs/`

## Notes

- Agent secrets/models live in **`.env.yiran`** (copy of Yiran `.env`).
  `YIRAN_ROOT` is still used to **build** the backend image from that tree.
- Phase 1 does **not** start RAG/Qdrant/OpenSandbox/OnlyOffice or the Yiran
  React frontend inside this compose file (those URLs in `.env` still apply
  if those services already run on your LAN).
- If `/yiran/` returns 502, check `docker compose logs yiran`.
# 独立服务器模式

推荐让浏览器始终访问 mind-map 同源的 `/yiran/*`，再由网关代理到独立部署的小策，避免 CORS 和前端持有服务凭证。

在 mind-map 根目录 `.env` 配置：

```env
YIRAN_UPSTREAM=https://xiaoce.example.com
```

地址填写小策服务根地址，不要带末尾 `/api`。远端小策须配置相同的 `MIND_MAP_YIRAN_SSO_SECRET`，然后运行 `start-with-remote-yiran.bat`。不配置 `YIRAN_UPSTREAM` 时仍默认使用 compose 内的 `http://yiran:8000`。

## 任务派发相关代理（`/jobhub`、`/bridge`）

脑图页面上的「运行」按钮要打到各台电脑的 WorkBuddy，而浏览器不能直连它们
（跨源，以及 Chrome/Edge 142 起的「本地网络访问」限制会拦公网页面访问回环/私网地址），
所以一律由网关**同源代理**：

| 路径 | 环境变量（默认） | 上游 |
|------|-----------------|------|
| `/jobhub/*` | `JOBHUB_UPSTREAM`（`http://host.docker.internal:5051`） | 通讯页 `scripts/workbuddy-lan-hub.py`：主机登记表 + 跨机派发中继 |
| `/bridge/*` | `BRIDGE_UPSTREAM`（`http://host.docker.internal:8799`） | 执行主机上的桥接 `test1.py --lan`：页面与 WorkBuddy 同机时走它 |

页面 → `/bridge/api/...` 是**同源请求**，没有跨源、也没有 https→http 混合内容，不受本地网络访问限制。

`/bridge` 还需要前端知道走**相对路径**，在 `docker/runtime-config.local.js` 里加一行
（该文件 gitignored，每个部署一份）：

```js
window.__MIND_MAP_RUNTIME__ = {
  // …原有配置…
  workbuddyJobBridge: '/bridge'
}
```

改完必须**重建 `app` 镜像**（前端与 nginx 都打在镜像里）：

```bash
docker compose build app && docker compose up -d app
```

验证（不用开浏览器）：`curl -s http://<网关地址>/bridge/api/gateways` 返回里有 `gateways` 即通。

> ⚠️ `/bridge/` 等于把「往这台机器派任务」开放给所有能打开页面的人（桥接 `--lan` 只校验
> 来源是内网/回环，nginx 反代过去的源 IP 是容器内网地址，会被放行）。公网部署别裸奔：
> 只在内网/VPN 用，或在防火墙/上层反代按来源 IP 限制。
