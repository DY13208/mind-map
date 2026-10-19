# File KB 部署说明（阶段 1）

1. `.env` 中设置 `KB_PGPASSWORD=<强随机>`，需要启用时设置 `FILE_KB_ENABLED=true`（默认 false：nginx `/api/kb/`、`/file-kb-mcp/` 返回 404，kb profile 不启动）。
2. app 至少启动过一次之后，管理员执行一次：
   `docker compose exec -T postgres psql -U postgres -d mind_map -v ON_ERROR_STOP=1 -v kb_password=<KB_PGPASSWORD> -f - < scripts/file-kb/bootstrap.sql`
3. `./Start-Docker.bat`（`FILE_KB_ENABLED=true` 时会带 `--profile kb` 并启动 file-kb / file-kb-worker / file-kb-mcp）。file-kb 启动时以 kb_app 执行 `src/migrations`。
4. Docling Serve 使用独立 profile `kb-docling`，镜像锁定为
   `ghcr.io/docling-project/docling-serve-cpu:v1.37.0@sha256:6eda9c524992147c1b0b06a1a9be4894bd68b1f43c86d92c32f996c4c60d18a3`。
   2026-10-16 已向 GHCR 核对 tag `v1.37.0` 的 manifest，digest 为
   `sha256:6eda9c524992147c1b0b06a1a9be4894bd68b1f43c86d92c32f996c4c60d18a3`。
   本机 `docker pull` 在这次实现结束时仍未完成，所以还没有对运行中的容器做 `/health` 或真实文件转换。
   未启动该 profile 时不要设置 `DOCLING_URL`。
   启动后把 `DOCLING_URL=http://docling-serve:5001` 传给 file-kb。
5. 注意：nginx.conf/start.sh 是打进 app 镜像的，修改后需重建 app（Start-Docker 会自动 build app）。

## 阶段 2 已实现
- 上传 `POST /api/kb/files`，原文写到 `KB_STORAGE_ROOT/library/`，并写入 `kb.files`、`kb.parse_runs`、`kb.jobs`。
- worker 用 `FOR UPDATE SKIP LOCKED` 领取任务，租约 120 秒，失败按 5/20/60 秒重试。
- 解析调用 Docling `POST /v1/convert/file/async`，结果写入 `kb.blocks`；表格行写入 `kb.fields` 和 `kb.records`。
- 原文、解析块和记录只返回 `owner_id` 与当前用户相同的文件。这不是四级权限。

## 尚未完成
- `kb.acl` 仍只有 viewer/editor。owner、manager、文件夹继承、团队授权和 MCP 工具级权限校验都没有做。
- MCP 只有即时会话校验，工具仍返回 501。
- 没有跨文件全文检索。表格的 sku/price/stock/record_date 列不会自动推断。
- `mind_map` 库里还没有 schema `kb`。现有 kb 表在独立库 `kb_scratch`。

## kb_scratch
`kb_scratch` 是 postgres 拥有的独立数据库，大约 8.6 MB。里面有 schema `kb`（迁移 `001_kb_schema`，表是空的）以及测试用的 `public.auth_sessions`、`public.wecom_users`（用户 `u_alice`）和一张空的 stub `public.room_nodes(id text, data text)`。它不是脑图库，compose 和 `.env` 的 `PGDATABASE` 仍是 `mind_map`。角色 `kb_app` 是 File KB 的登录角色，能连接 `mind_map` 和 `kb_scratch`，不要把它当成 scratch 数据删掉。

清理前先确认没有进程把 `PGDATABASE` 指到 `kb_scratch`，并确认 `u_alice` 的会话只是夹具。确认后由管理员执行 `DROP DATABASE kb_scratch;`。不要在同一步删除 `kb_app`，也不要删除 `mind_map` 里的 `knowledge` schema。

文档：baseline.md（改动前基线）、auth.md（认证边界）。
