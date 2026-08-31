# 局域网思维导图

基于 [simple-mind-map](https://github.com/wanglin2/mind-map) 二次使用，用于在本机和局域网里画思维导图，并支持多人实时协同。

Docker 与开发启动的完整端口列表见 [PORTS.md](./PORTS.md)。

功能说明仍以官方文档为准：

> [https://wanglin2.github.io/mind-map-docs/](https://wanglin2.github.io/mind-map-docs/)

---

## 能做什么

- 本机打开网页即可编辑思维导图
- 一键探测本机 IP，局域网同事用同一个地址访问
- 同一房间实时协同编辑
- 导图自动保存到 PostgreSQL + 腾讯云 COS（`mind-map/` 文件夹）
- 导入 / 导出常见格式，主题、大纲、演示等功能可直接用
- 可选 AI 功能（需自行配置密钥）

---

## 环境

- Windows
- 日常运行推荐 [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- 本地开发才需要 [Node.js](https://nodejs.org/)（建议 18+）

数据库和对象存储配置写在项目根目录的 `.env`（和启动脚本同一级）。可先复制 `.env.example`。COS 密钥仍用你现在的；Postgres 在 Docker 里自带，不必再在本机单独开。

---

## 推荐：Docker 一键启动

协同、MCP、AI、数据库都在容器里，**对外只开一个端口**（默认 `8080`）。

1. 先装并打开 Docker Desktop。
2. 双击 `启动-Docker.bat`（或 `启动.bat` 选 `[5]`）。
3. 用窗口打印的地址访问，例如 `http://192.168.x.x:8080`。

```bash
node scripts/docker-up.js        # 探测 IP、构建、启动
node scripts/docker-up.js down   # 停止
```

WorkBuddy 用同一个端口的 MCP：`http://主机IP:8080/mcp`，启动脚本会写入 `.mcp.json`。防火墙只放行 `8080`。

本地改代码调试，再用下面的 Node 多进程启动。

---

## 本地开发启动

需要本机已装 Node.js。双击 `启动.bat`。

| 选项 | 作用 |
| --- | --- |
| `1` | 获取本机 IP，并设为对外使用的地址 |
| `2` | 启动全部服务（页面、协同、AI、MCP） |
| `3` | 设 IP 并启动全部服务 |
| `4` | 停止全部本地服务 |
| `5` | Docker 一键启动（只对外开一个端口） |
| `6` | 停止 Docker |

关掉启动窗口，或双击 `停止.bat`，本地 Node 服务会一起停掉。Docker 用 `启动-Docker.bat down` 或菜单 `[6]`。

也可以用命令行：

```bash
node scripts/launcher.js          # 打开菜单
node scripts/launcher.js docker   # Docker 启动
node scripts/launcher.js start    # 本地 Node 启动
node scripts/launcher.js stop     # 停止本地 Node 服务
```

---

## 对外端口

**Docker（推荐）只暴露：**

| 地址 | 说明 |
| --- | --- |
| `http://本机IP:8080` | 网页、协同、AI、MCP 都走这里 |
| `http://本机IP:8080/mcp` | WorkBuddy MCP |

容器内部仍有协同、MCP、AI、Postgres，不映射到主机。

**本地 Node 开发才会用到这些端口：**

| 服务 | 地址 |
| --- | --- |
| 页面 | `http://本机IP:8081` |
| 协同 | `ws://本机IP:1234` |
| AI | `http://本机IP:3456` |
| MCP | `http://本机IP:3847/mcp` |

WorkBuddy、Cursor 的 MCP 配置见 [MCP.md](./MCP.md)。

---

## 多人协同

1. 主机用 `启动.bat` 把服务跑起来。
2. 所有人打开同一个页面地址，例如 `http://192.168.0.204:8081`。
3. 点工具栏 **协同**，填昵称，加入**同一个房间号**。
4. 协同服务地址用 `ws://本机IP:1234`。启动脚本写过 IP 后，页面会自动带上，一般不用改。
5. 点 **复制邀请链接** 发给同事，链接里会带房间号。

同一局域网才能连上。Docker 模式下防火墙放行 `8080`；本地 Node 模式再放行 `8081`、`1234`、`3847`。

WorkBuddy 也可以进同一个房间：先让 MCP 服务跟着启动台起来，按 [MCP.md](./MCP.md) 配好后，把 `share_url` 发给同事即可两边一起改。

协同面板里可以看到已保存的文件，支持打开、重命名、删除。进入房间后会自动写入：

- PostgreSQL 表 `rooms`：房间号、标题、更新时间
- COS 对象：`mind-map/{房间号}.yjs`（和现有 `media/` 等目录分开）

---

## 目录

```
mind-map/
  启动-Docker.bat         Docker 一键启动（推荐）
  启动.bat                 本地 Node / 菜单
  停止.bat                 停止本地 Node 服务
  docker-compose.yml      容器编排
  MCP.md                  WorkBuddy / Cursor MCP 配置
  scripts/launcher.js     启动台
  web/                    网页端
  simple-mind-map/        思维导图库（含协同服务和 MCP）
```

---

## 常见问题

**页面能开，但协同连不上**  
Docker：确认容器在跑，页面地址是 `http://本机IP:8080`，双方房间号一致。本地 Node：协同地址是 `ws://本机IP:1234`。

**同事访问不了 192.168.x.x**  
双方要在同一局域网。Docker 放行 8080；不要把 `localhost` 链接发给别人。

**协同面板里没有文件**  
先加入房间并稍等 2 秒，再点刷新。文件会写到 PostgreSQL 的 `rooms` 表，以及 COS 的 `mind-map/` 文件夹。

**AI 不可用**  
AI 服务会随启动脚本一起起来。还要在页面里填好自己的 API Key。不配也能正常画图和协同。
