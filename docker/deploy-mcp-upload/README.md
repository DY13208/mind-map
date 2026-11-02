# 一次性直传票据 · 服务器部署包

给远端 mind-map（xx.stillgroup.net:8989）装一条「Agent 直传文件」通道：
**票据签发 → curl 直传原始字节 → upload_attachment 换真身挂载**。解决 Agent 手里
的文件在它自己电脑上、MCP 服务在服务器容器里读不到、手工搬运 base64 又必然出错的问题。

## 为什么是补丁而不是覆盖文件

服务器上的 MCP 代码比本地仓库新（有 `list_automatic_d_nodes` 等本地没有的工具），
直接覆盖会丢掉新功能。所以这里只做三处增量：

| 文件 | 动作 |
| --- | --- |
| `mcpUploadTickets.mjs` | 新增（独立模块，不依赖项目代码） |
| `mcpUploadBridge.mjs` | 新增（包装 `resolveAttachmentUploadInput`，加 `/mcp-upload/*` 路由处理） |
| `mcpServer.mjs` | 补丁：① import 路径改指向桥接模块 ② 补一行 import ③ 在 `/mcp` 判定前插路由 |

补丁脚本幂等（认出已打就跳过）、锚点找不到就整体放弃、改完 `node --check`，不通过自动回滚。

## 1. 上传文件到服务器

把这 4 个文件传到服务器任意目录，例如 `/root/deploy-mcp-upload/`：

```
mcpUploadTickets.mjs
mcpUploadBridge.mjs
patch-mcp-upload.mjs
deploy-on-server.sh
```

（`scp -r deploy-mcp-upload root@<服务器>:/root/`）

## 2. 执行部署

```sh
cd /root/deploy-mcp-upload
sh deploy-on-server.sh            # 容器名默认 mind-map-app-1，不同就传参
```

脚本会：拷模块 → 打补丁 → 重启 MCP 进程（`kill $(cat /tmp/mcp.pid)`，start.sh 的
supervise 会在 1 秒后拉起）→ 容器内 ping 自检。

看到 `{"ok":true,"route":"mcp-upload"}` 即 MCP 侧就绪。

## 3. 加 nginx 转发（必须，否则公网 405）

见同目录 `nginx-mcp-upload.snippet.conf`：外层 TLS nginx 和容器内 app nginx 都要在
已有 `location = /mcp { ... }` 后面贴一个 `location /mcp-upload/` 块，然后

```sh
nginx -t && nginx -s reload          # 外层
docker exec mind-map-app-1 nginx -t && docker exec mind-map-app-1 nginx -s reload
```

> 容器内 nginx 配置若由 `/etc/nginx/nginx.conf.template` 渲染，两个文件都要改，否则
> 容器重启后改动丢失。

## 4. 验收

```sh
# a) 外层能转发到 MCP（应返回 {"ok":true,"route":"mcp-upload"}）
curl -s -X POST --noproxy '*' https://xx.stillgroup.net:8989/mcp-upload/ping

# b) 能签发票据（应返回 upload_id / upload_path / 提示）
curl -s -X POST --noproxy '*' \
  "https://xx.stillgroup.net:8989/mcp-upload/new?room_key=room-yk3tz4aj&file_name=probe.txt"

# c) 能收字节（把 <id> 换成上一步的 upload_id，应返回 {"ok":true,"bytes":N}）
printf 'hello' | curl -s -X POST --data-binary @- \
  "https://xx.stillgroup.net:8989/mcp-upload/<id>"
```

## 5. Agent 侧用法（部署后）

```sh
# 1) 签票据
curl -s -X POST "https://xx.stillgroup.net:8989/mcp-upload/new?room_key=room-yk3tz4aj&node=<节点uid>&file_name=简历.html&mime_type=text/html"
# 2) 直传字节（不要 base64）
curl -s -X POST --data-binary @/本地/绝对/路径/简历.html "https://xx.stillgroup.net:8989/mcp-upload/<upload_id>"
# 3) 挂载：upload_attachment(room_key=..., node=..., content_base64="__ticket__:<upload_id>", file_name="简历.html")
```

票据一次性，TTL 默认 900 秒，上限 24MiB；挂载成功或失败都会释放临时文件。

## 6. 回滚

```sh
docker exec mind-map-app-1 ls /app/simple-mind-map/bin/ | grep mcpServer.mjs.bak
docker cp mind-map-app-1:/app/simple-mind-map/bin/mcpServer.mjs.bak-<时间戳> ./mcpServer.mjs
docker cp ./mcpServer.mjs mind-map-app-1:/app/simple-mind-map/bin/mcpServer.mjs
docker exec mind-map-app-1 sh -c 'kill $(cat /tmp/mcp.pid)'
```

新增的两个模块留着不影响（没被引用就不生效）。

## 7. 备选：零改动的一次性方案

如果只是今天要挂一个文件、不想动服务器代码：把文件 `scp` 到服务器的容器可见路径，
再让 Agent 用 `upload_attachment(file_path=...)`：

```sh
scp 简历.html root@<服务器>:/tmp/简历.html
docker cp /tmp/简历.html mind-map-app-1:/app/output/简历.html
# 然后 upload_attachment(room_key=..., node=..., file_path="/app/output/简历.html")
```

## 已验证情况

- 本机容器（同源代码，nginx 1.22.1）：补丁 + 桥接 + 端到端 HTTP 流程全部通过
  （票据 34 字节往返、`__ticket__` 换真身、二次使用被拒、普通 base64 不受影响、
  `export *` 其他导出保留）。
- 服务器侧未执行（需你在服务器上跑）；锚点匹配用的是缩进无关正则，兼容不同版本格式。
