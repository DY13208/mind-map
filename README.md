# SimpleMindMap（思绪思维导图）

> 一个强大的思维导图。A powerful mind map.

基于 [simple-mind-map](https://github.com/wanglin2/mind-map) 二次使用，用于在本机和局域网里画思维导图，并支持多人实时协同。

![GitHub License](https://img.shields.io/github/license/DY13208/mind-map)
![Language](https://img.shields.io/badge/Language-JavaScript%20%7C%20Vue-blue)

Docker 与开发启动的完整端口列表见 [PORTS.md](./PORTS.md)。

功能说明仍以官方文档为准：

> [https://wanglin2.github.io/mind-map-docs/](https://wanglin2.github.io/mind-map-docs/)

---

## ✨ 能做什么

- 💻 本机打开网页即可编辑思维导图
- 🌐 一键探测本机 IP，局域网同事用同一个地址访问
- 👥 同一房间实时协同编辑
- 💾 导图自动保存到 PostgreSQL + 腾讯云 COS（`mind-map/` 文件夹）
- 📤 导入 / 导出常见格式，主题、大纲、演示等功能可直接用
- 🤖 可选 AI 功能（需自行配置密钥）
- ⚡ 「补齐流程」等功能依赖本机 **WorkBuddy 桌面客户端**；用 `启动.bat` / Docker 启动时会自动拉起 API 代理

---

## 🔧 补齐流程前置条件（每台 Windows 电脑各装一次）

1. 安装 [Python 3.10+](https://www.python.org/)，勾选 **Add python.exe to PATH**
2. 安装并登录 **WorkBuddy 桌面版**（默认路径 `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe`）
3. 再运行 `启动.bat` 或 `启动-Docker.bat`

> 未安装 WorkBuddy 时导图、协同仍可用，只是「补齐流程」会提示未就绪。

---

## 📋 环境要求

- **操作系统：** Windows
- **容器化：** 日常运行推荐 [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- **本地开发：** [Node.js](https://nodejs.org/)（建议 18+）
- **数据库：** PostgreSQL（Docker 中自带）
- **对象存储：** 腾讯云 COS（可选）

数据库和对象存储配置写在项目根目录的 `.env`（和启动脚本同一级）。可先复制 `.env.example`。COS 密钥仍用你现在的；Postgres 在 Docker 里自带，不必再另行配置。

如需限制为企业成员访问，可启用企业微信扫码单点登录。完整的后台配置、环境变量和验收步骤见 [WECOM_AUTH.md](./WECOM_AUTH.md)。

---

## 🚀 推荐：Docker 一键启动

协同、MCP、AI、数据库都在容器里，**对外只开一个端口**（默认 `8080`）。

### 快速开始

1. 先装并打开 Docker Desktop。
2. 双击 `启动-Docker.bat`（或 `启动.bat` 选 `[5]`）。
3. 用窗口打印的地址访问，例如 `http://192.168.x.x:8080`。

```bash
node scripts/docker-up.js        # 探测 IP、构建、启动
node scripts/docker-up.js down   # 停止
```

### MCP 配置

WorkBuddy 用同一个端口的 MCP：`http://主机IP:8080/mcp`，启动脚本会写入 `.mcp.json`。防火墙只放行 `8080`。

本地改代码调试，再用下面的 Node 多进程启动。

---

## 💻 本地开发启动

需要本机已装 Node.js。双击 `启动.bat`。

### 菜单选项

| 选项 | 作用 |
| --- | --- |
| `1` | 获取本机 IP，并设为对外使用的地址 |
| `2` | 启动全部服务（页面、协同、AI、MCP） |
| `3` | 设 IP 并启动全部服务 |
| `4` | 停止全部本地服务 |
| `5` | Docker 一键启动（只对外开一个端口） |
| `6` | 停止 Docker |

关掉启动窗口，或双击 `停止.bat`，本地 Node 服务会一起停掉。Docker 用 `启动-Docker.bat down` 或菜单 `[6]`。

### 命令行启动

也可以用命令行：

```bash
node scripts/launcher.js          # 打开菜单
node scripts/launcher.js docker   # Docker 启动
node scripts/launcher.js start    # 本地 Node 启动
node scripts/launcher.js stop     # 停止本地 Node 服务
```

### 可选：CodeGraph 代码索引

本地安装 CodeGraph 后，可在项目根目录初始化代码索引：

```bash
codegraph init .
codegraph sync .
codegraph status .
```

索引会自动排除 `dist-build/` 和 `dist-docker/`。`.codegraph/` 中的 SQLite 数据库和运行状态文件仅保存在本机，Git 只跟踪用于阻止这些数据误提交的 `.codegraphignore`。

---

## 🌐 对外端口

### Docker（推荐）只暴露：

| 地址 | 说明 |
| --- | --- |
| `http://本机IP:8080` | 网页、协同、AI、MCP 都走这里 |
| `http://本机IP:8080/mcp` | WorkBuddy MCP |

容器内部仍有协同、MCP、AI、Postgres，不映射到主机。

### 本地 Node 开发才会用到这些端口：

| 服务 | 地址 |
| --- | --- |
| 页面 | `http://本机IP:8989` |
| 协同 | `ws://本机IP:1234` |
| AI | `http://本机IP:3456` |
| MCP | `http://本机IP:3847/mcp` |

WorkBuddy、Cursor 的 MCP 配置见 [MCP.md](./MCP.md)。

---

## 👥 多人协同指南

### 局域网协同步骤

1. 主机用 `启动.bat` 把服务跑起来。
2. 所有人打开同一个页面地址，例如 `http://192.168.0.204:8989`。
3. 点工具栏 **协同**，填昵称，加入**同一个房间号**。
4. 协同服务地址用 `ws://本机IP:1234`。启动脚本写过 IP 后，页面会自动带上，一般不用改。
5. 点 **复制邀请链接** 发给同事，链接里会带房间号。

### 防火墙配置

同一局域网才能连上。
- **Docker 模式：** 放行 `8080`
- **本地 Node 模式：** 放行 `8989`、`1234`、`3847`

### WorkBuddy 集成

WorkBuddy 也可以进同一个房间：先让 MCP 服务跟着启动台起来，按 [MCP.md](./MCP.md) 配好后，把 `share_url` 发给同事即可两边一起改。

### 协同数据存储

协同面板里可以看到已保存的文件，支持打开、重命名、删除。进入房间后会自动写入：

- PostgreSQL 表 `rooms`：房间号、标题、更新时间
- COS 对象：`mind-map/{房间号}.yjs`（和现有 `media/` 等目录分开）

---

## 📁 项目结构

```
mind-map/
├── 启动-Docker.bat           # Docker 一键启动（推荐）
├── 启动.bat                  # 本地 Node / 菜单
├── 停止.bat                  # 停止本地 Node 服务
├── docker-compose.yml        # 容器编排
├── .env.example              # 环境变量示例
├── MCP.md                    # WorkBuddy / Cursor MCP 配置
├── WECOM_AUTH.md             # 企业微信扫码登录配置
├── PORTS.md                  # 完整端口列表
├── scripts/
│   └── launcher.js           # 启动台
├── web/                      # 网页端（Vue + JavaScript）
└── simple-mind-map/          # 思维导图库（含协同服务和 MCP）
```

---

## ❓ 常见问题

### 页面能开，但协同连不上

- **Docker：** 确认容器在跑，页面地址是 `http://本机IP:8080`，双方房间号一致。
- **本地 Node：** 协同地址是 `ws://本机IP:1234`。

### 同事访问不了 192.168.x.x

双方要在同一局域网。Docker 放行 8080；不要把 `localhost` 链接发给别人。

### 协同面板里没有文件

先加入房间并稍等 2 秒，再点刷新。文件会写到 PostgreSQL 的 `rooms` 表，以及 COS 的 `mind-map/` 文件夹。

### AI 不可用

AI 服务会随启动脚本一起起来。还要在页面里填好自己的 API Key。不配也能正常画图和协同。

### Docker 容器启动失败

1. 确保 Docker Desktop 已启动并正常运行
2. 检查端口 8080 是否被占用：`netstat -ano | findstr :8080`
3. 查看 Docker 日志：`docker logs mind-map-web`
4. 尝试删除容器重新启动：`docker-compose down && docker-compose up`

---

## 🔗 相关链接

- **上游项目：** [wanglin2/mind-map](https://github.com/wanglin2/mind-map)
- **官方文档：** [https://wanglin2.github.io/mind-map-docs/](https://wanglin2.github.io/mind-map-docs/)
- **企业微信登录配置：** [WECOM_AUTH.md](./WECOM_AUTH.md)
- **MCP 配置：** [MCP.md](./MCP.md)

---

## 📊 技术栈

- **前端：** Vue.js, JavaScript (78.5%)
- **标记语言：** HTML (0.3%), CSS (0.1%)
- **后端：** Node.js, JavaScript
- **数据库：** PostgreSQL
- **容器化：** Docker
- **协同编辑：** Yjs
- **其他：** Shell, PLpgSQL

---

## 📝 License

查看 LICENSE 文件获取许可证信息。

---

**最后更新：** 2026-09-14
