# 思维导图 MCP 配置教程

人和 WorkBuddy 改的是同一间协同房间。推荐用 Docker：内部仍有协同 / MCP / AI / 数据库，**对外只开 `8080`**。

```
WorkBuddy -- http://主机IP:8080/mcp -->  网关
同事浏览器 -- http://主机IP:8080     -->  网关 --> 网页 / 协同 / AI
```

IP 由启动脚本探测，不要手写，也不要用 `127.0.0.1`（WorkBuddy 不在这台电脑上时，那会连到它自己）。

---

## 1. 工具一览

| 工具 | 作用 |
| --- | --- |
| `list_maps` | 列出房间，含给人类打开的 `share_url` |
| `create_map` | 新建导图 |
| `get_map` | `format=outline` 只返回大纲（每行带 uid，默认最多 800 节点）；`format=full` 只返回完整树 |
| `search_nodes` | 按文字搜节点 |
| `add_node` | 在父节点下加子节点 |
| `update_node` | 改文字 / 备注 |
| `delete_node` | 删节点（含子树，不能删根） |
| `replace_tree` | 整树覆盖，适合一次生成 |
| `rename_map` | 改房间标题 |
| `delete_map` | 删除房间 |
| `get_share_link` | 只取网页邀请链接 |

1. AI 调用 `create_map` 或 `list_maps`
2. 把返回的 `share_url` 发给同事
3. 同事打开链接，自动进入同一房间
4. AI 继续 `add_node` / `update_node`，网页上立刻能看到

---

## 2. WorkBuddy（Docker，推荐）

1. 安装并打开 Docker Desktop。
2. 双击 `启动-Docker.bat`。
3. 把窗口打印的配置，或项目里生成的 `.mcp.json`，贴进 WorkBuddy → Connections → Custom connections → Configure MCP。

地址形如：

```json
{
  "mcpServers": {
    "mind-map": {
      "type": "http",
      "url": "http://<启动脚本打印的主机IP>:8080/mcp"
    }
  }
}
```

确认：从跑 WorkBuddy 的机器访问 `http://<主机IP>:8080/health`，应返回 `{"ok":true,"gateway":true}`。防火墙放行 `8080`。

换网或换 IP 后重新跑一次启动脚本，再把新的 `.mcp.json` 配进 WorkBuddy。

### 可选令牌

在 `.env` 里设 `MCP_TOKEN=...` 后重新 `启动-Docker.bat`。配置里加上：

```json
"headers": {
  "Authorization": "Bearer 与 .env 里相同的 token"
}
```

试一句：

> 列出当前思维导图，然后新建一张叫「周会」的图，把分享链接给我。

---

## 3. 本地 Node 开发（多端口）

只有在本机用 `启动.bat` 跑 Node 进程时，MCP 才是 `http://主机IP:3847/mcp`。日常给 WorkBuddy 用 Docker 即可。

Cursor stdio 仍用 `.cursor/mcp.json`，协同接口走本机 `127.0.0.1:1234`，需要本机协同服务已启动。

---

## 4. 常见问题

**connect ECONNREFUSED**  
容器或 MCP 没起来。先 `启动-Docker.bat`，再在 WorkBuddy 里点重连。不要用 `127.0.0.1`，不要再用 `:3847`（Docker 模式下是 `:8080/mcp`）。

**WorkBuddy 里看不到工具**  
HTTP 模式只配 `url`，不要配 `command`。用启动脚本打印的地址。

**网页上没同步**  
人必须打开同一 `share_url`（带 `?room=`）。
