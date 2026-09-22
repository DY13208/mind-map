# 给线上部署补上 Wiki 写工具（knowledge-mcp 0.5.0 → 0.6.0 → 0.6.1）

> 结论先说：**线上缺的不是「补一个工具」，而是整个 `0.6.0` 镜像没发布出去。**
> 写工具（`wiki_create` / `wiki_update`）只存在于本地未提交的工作区改动里，
> 线上无论怎么构建都拿不到。

## 1. 事实核查（2026-09-21 实测）

| 项 | 本机（127.0.0.1:18792） | 线上（xx.stillgroup.net:8989） |
|---|---|---|
| 工具总数 | **18** | **16** |
| `wiki_*` 工具 | create / read / search / spaces / tree / **update** | read / search / spaces / tree（**只读**） |
| 镜像 | `mind-map-knowledge-mcp:0.6.0` | 等价 `0.5.0` |
| 读 Wiki | 正常 | 正常（4 个空间） |

各镜像实际注册的工具数（`docker run` 实测 `grep -c "^  { name: '"`）：

| 镜像 tag | 工具数 | `wiki_*` 个数 | 有写能力 |
|---|---|---|---|
| `mind-map-knowledge-mcp:0.4.0` | — | 0 | 否 |
| `mind-map-knowledge-mcp:0.5.0` | **16** | 4 | 否 |
| `mind-map-knowledge-mcp:0.6.0` | **18** | 6 | **是** |

线上 16 个工具与 `0.5.0` **精确吻合**，据此判定线上跑的是 `0.5.0`。

## 2. 根因：写工具的代码从未提交

```bash
$ cd /e/yiran_0828/mind-map
$ git log -S "wiki_create" --oneline -- integrations/knowledge-mcp/src/server.js
(无输出)                     # ← 从未提交过

$ git diff --stat HEAD -- integrations/knowledge-mcp/
 src/adapters/wiki.js  | 155 ++++++++++++++++++-   # 写实现全在这里
 src/auth/jwt.js       |  52 ++++++++-             # TTL=0 永久票
 src/server.js         |  32 +++++-                # TOOLS + VERSION 0.5.0→0.6.0
```

关键证据：`git diff HEAD` 显示 HEAD 里 `VERSION = '0.5.0'`，工作区才改成 `'0.6.0'`。
**线上按 git 上的代码构建，必然得到 0.5.0。**

另外本分支 `feat/wiki-sidebar-sso` 落后远端 1172 个提交（`ahead 1172`），
也就是说这批改动既没提交、也没推送。

## 3. 升级前的关键判断：不用补 env

**线上读 Wiki 正常 → 写入所需的三个变量已经就绪。**

原因：读和写走的是同一个函数 `docmostApi(userId, path, …)`，它要求
`DOCMOST_DATABASE_URL` + `DOCMOST_APP_SECRET` 齐备（缺了会直接抛
`wiki_unconfigured`），并需要一个可连的 `DOCMOST_INTERNAL_URL`。

```js
// integrations/knowledge-mcp/src/adapters/wiki.js:86
function requireConfig(env = process.env) {
  const c = cfg(env);
  if (!c.databaseUrl || !c.appSecret) {
    throw fail('wiki_unconfigured', 'wiki_unconfigured: Docmost database or app secret missing');
  }
  return c;
}
```

既然线上 `wiki_spaces` / `wiki_search` 都能跑通，说明这三个变量都已配好。
**所以本次升级是「只换镜像」，不需要动线上 env。**

（唯一例外：线上 Docmost 版本若不含 `/api/pages/create`、`/api/pages/update`，
写入会 404。本地 `mind-map-docmost:0.96.0` 两个接口都有；线上 Docmost 版本
不一致时按第 5 节验证。）

## 4. 升级步骤（在线上服务器执行）

写工具的写入通道是「以调用者身份借道 Docmost 官方 HTTP 接口」——不借权：
mind-map userId ↦ Docmost 账号，用该账号自己的 session 调 Docmost。
所以线上实例**必须与线上的 Docmost 同网络**，能解析到 `docmost:3000`。

### 步骤 1：把改动提交并推送到线上能拉到的位置

```bash
cd /e/yiran_0828/mind-map

git add integrations/knowledge-mcp/ MCP.md .env.example docker-compose.yml \
        web/src/pages/ProductShell/McpAccessPage.vue \
        scripts/wiki-mcp-token.js simple-mind-map/bin/knowledgeMcpToken.js \
        integrations/openclaw/liangce-ingress/index.js \
        integrations/knowledge-mcp/tests/wiki-write.test.js
git commit -m "feat: Wiki 全库读写（wiki_create / wiki_update）+ 永久 Token"
git push
```

> 注意：`scripts/` 下那批**未跟踪**的辅助脚本（`wiki-endpoint.js`、
> `wiki-contract-*.js`、`docx-revisions.py` 等）按需一并提交，否则线上跑
> 合同提取流程时会缺文件。

### 步骤 2：先本地验证 0.6.0 自身没问题

```bash
cd integrations/knowledge-mcp
node --test tests/wiki-write.test.js      # 实测 4/4 通过
```

### 步骤 3：在线上服务器构建并重启

```bash
cd <线上 mind-map 部署目录>
git pull

# 方式 A：走项目自带的编排（会自动比对源码指纹，命中则跳过重建）
node scripts/docker-up.js

# 方式 B：手动只重建这一个服务
docker compose -f docker-compose.yml build knowledge-mcp
docker compose -f docker-compose.yml up -d knowledge-mcp
```

`docker-compose.yml` 里该服务已指向 0.6.0（本工作区改动）：

```yaml
  knowledge-mcp:
    build:
      context: ./integrations/knowledge-mcp
      dockerfile: Dockerfile
    image: mind-map-knowledge-mcp:0.6.0        # ← 0.5.0 改为 0.6.0
    environment:
      KNOWLEDGE_WIKI_MAX_BODY: ${KNOWLEDGE_WIKI_MAX_BODY:-120000}
      KNOWLEDGE_MCP_MAX_WRITE_CHARS: ${KNOWLEDGE_MCP_MAX_WRITE_CHARS:-200000}
      KNOWLEDGE_MCP_MAX_BODY_BYTES: ${KNOWLEDGE_MCP_MAX_BODY_BYTES:-1000000}
```

若线上是独立编排文件，照此补上这三个变量：
`KNOWLEDGE_MCP_MAX_WRITE_CHARS` 默认 200000，**写「公司模型」这类大页会被它拦住**
（返回 `content_too_large`），按需调大。

### 步骤 4：跨机部署才需要放开绑定

`docker-compose.yml` 默认把端口绑回环：

```yaml
      - "${KNOWLEDGE_MCP_BIND:-127.0.0.1}:${KNOWLEDGE_MCP_PORT:-18792}:18792"
```

线上若仍由 Nginx 走 `/knowledge-mcp/` 反代（`docker/nginx.conf:174-175`
→ `proxy_pass http://knowledge-mcp:18792/`），**保持回环即可，不用改**。
确实需要跨机直连时才设 `KNOWLEDGE_MCP_BIND=0.0.0.0` 并配防火墙。

### 步骤 5：验收（必做）

```bash
# 在任意能访问该端点的机器上
node scripts/wiki-write-check.js https://xx.stillgroup.net:8989/knowledge-mcp/mcp
```

期望输出：

```
工具总数    : 18
wiki_* 工具 : wiki_create, wiki_read, wiki_search, wiki_spaces, wiki_tree, wiki_update
含 wiki_create: 是
含 wiki_update: 是
判定        : 具备写能力（0.6.0+）
```

脚本退出码 `0` = 具备写能力，`1` = 仍只读，可直接接进 CI 或巡检。

再补一次真实写入验证（**写进无用的临时页，验完删掉**）：

```
wiki_create  spaceId=<某个你有权限的空间> title=__write_probe__ content=ok
wiki_update  pageId=<上一步返回的 pageId> content=ok2 operation=append
wiki_read    pageId=<上一步返回的 pageId>
```

三处都要过，才算真的通了。**不要拿正式页面做首次验证。**

## 5. 常见失败与处置

| 现象 | 原因 | 处置 |
|---|---|---|
| `wiki_unconfigured` | 线上缺 `DOCMOST_DATABASE_URL` / `DOCMOST_APP_SECRET` | 补 `.secrets/wiki.env` 的两个值（与线上 Docmost 库一致），重启 |
| `wiki_identity_unmapped` | 该 mind-map 账号没在 Wiki 登录过 | 先在 Wiki 页面完成一次单点登录 |
| `content_too_large` | 正文超 `KNOWLEDGE_MCP_MAX_WRITE_CHARS`（默认 200000） | 调大该变量并重启 |
| `payload_too_large` | 请求体超 `KNOWLEDGE_MCP_MAX_BODY_BYTES`（默认 1000000） | 调大该变量 |
| 404 on `/api/pages/create` | 线上 Docmost 版本不支持该接口 | 对齐 Docmost 版本（本地为 0.96.0） |
| 工具数仍是 16 | 镜像没换成功 / 拉的是旧代码 | 核对 `docker images` 里的 tag 与实际 `VERSION` |

## 6. 为什么这类问题很难发现

两端 pageId 体系不同（线上 `01a0aef2-…`/`01a0c2b2-…`，本机 `01a0b928-…`），
且 tool-call 一律返回 `status: ok`。**「写成功」只是本机那套 Docmost 成功**，
线上页面里什么都没有，肉眼完全看不出来。

已加的两道防线：

1. `scripts/wiki-endpoint.js` —— 端点唯一解析处，以 `~/.workbuddy/mcp.json` 的
   `mind-map-wiki.url` 为准；回退本机或解析出回环地址都会打醒目告警。
2. `scripts/wiki-contract-node-insert.js` 的页面来源校验 —— 写入前先验证
   「MCP 返回的 pageId 在本机 Docmost 库里存在」，不匹配即中止（读 A 写 B 防护）。

---

## 7. 0.6.1：跨机安全写入（读写同源，2026-09-22 增补）

0.6.0 只解决了「线上有写工具」，但插入脚本的读通道仍是**本机 psql**——
写线上时依然是「读 A（本机库）写 B（线上）」。0.6.1 从根上修掉：

- `wiki_read` 新增 `format=json`：直接返回 Docmost 存储的 ProseMirror content
  原文（`/api/pages/info` 对 json 透传，不渲染）。
- `wiki-contract-node-insert.js --content-from-mcp`：整页 content 改走 MCP 读取，
  读与写同一端点，天然同源，**写线上不再依赖本机 Docker**。

### 线上部署 0.6.1

```bash
# 1) 本地：提交推送（0.6.1 = wiki_read json + 大页面限制已进 compose）
git add -A && git commit -m "feat: knowledge-mcp 0.6.1 wiki_read format=json；跨机读写同源" && git push

# 2) 线上服务器
cd <部署目录> && git pull

#    .env 追加（公司模型整页 JSON 约 131 万字符，默认 120000/200000/1000000 全不够）
KNOWLEDGE_WIKI_MAX_BODY=2000000        # wiki_read 整页读取上限
KNOWLEDGE_MCP_MAX_WRITE_CHARS=3000000  # wiki_update 整页写回上限
KNOWLEDGE_MCP_MAX_BODY_BYTES=8000000   # 请求体上限（JSON 转义后体积膨胀）

#    .env 确认已有（线上能读 Wiki 即已具备）：
#    DOCMOST_DATABASE_URL=postgresql://…@docmost-db:5432/docmost
#    DOCMOST_APP_SECRET=…

docker compose -f docker-compose.yml build knowledge-mcp
docker compose -f docker-compose.yml up -d knowledge-mcp

# 3) 任意机器验收
node scripts/wiki-write-check.js https://xx.stillgroup.net:8989/knowledge-mcp/mcp --expect 18
```

### 写线上合同（全部在本机执行）

```bash
node scripts/wiki-contract-node-insert.js --elements data/contracts/huke-still0730.json           # 预演
node scripts/wiki-contract-node-insert.js --elements data/contracts/huke-still0730.json --apply   # 写入
```

端点/令牌自动取 mcp.json。脚本流程：MCP 读整页 JSON（130 万字符）→ 备份到
`tmp/wiki-backup/` → 定位「合同 → 直播推广」→ 要素名强校验 → 查重 → 纯新增校验
→ `wiki_update`（format=json）→ 搜索索引命中 + 回读复核。

本机自测可用 `--url http://127.0.0.1:18792/mcp --token <本地签发的token>`，
token 用 `node scripts/wiki-mcp-token.js dev-local --ttl 3600` 签。
