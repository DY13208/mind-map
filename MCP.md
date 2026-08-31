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
| `get_map` | `format=outline` 大纲（默认最多 800 节点）；`format=full` 树（超大图会截断，可用 `max_nodes`） |
| `search_nodes` | 按文字搜节点 |
| `list_todos` | 列出待办，可选同时读取已完成 |
| `prepare_todo` | 读取待办并匹配任意SOP的C/P |
| `complete_todo` | 全部C通过后把任务移动到已完成 |
| `propose_sop_improvement` | 生成SOP完善建议，不写入 |
| `apply_sop_improvement` | 用户确认后应用原建议 |
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

## 2. CPDA 待办规则

CPDA 是所有业务共用的执行协议，不是招聘等某一种业务的固定流程：

- `C（Check）`：SOP 中的检查条件和完成验收标准。
- `P（Plan）`：SOP 中的执行计划和步骤。
- `D（Do）`：用户写入待办并向 WorkBuddy/AI 发出任务指令。
- `A（AI Action）`：WorkBuddy/AI 根据 C/P 调用可用工具完成事项。

思维导图只保留两个任务位置：

```text
待办
├── 待办（n）
│   └── 未完成任务
└── 已完成（n）
    └── 已完成任务
```

进度、缺少信息、执行失败和待人工处理事项只在 WorkBuddy/AI 对话中显示，
不写成新的思维导图状态。未满足全部 C 时任务继续留在「待办」；满足后
`complete_todo` 才会移动整棵任务节点到「已完成」。

### SOP结构

MCP不包含招聘、财务、法务等硬编码字段，只识别通用结构。每个可执行的
SOP目标必须同时拥有 C 和 P：

```text
SOP
└── 任意业务目标
    ├── C
    │   ├── 检查项一
    │   └── 检查项二
    └── P
        ├── 执行步骤一
        └── 执行步骤二
```

为了兼容已有导图，C节点也可命名为 `Check`、`检查`或`目标`，P节点也可
命名为 `Plan`或`计划`。验收时以 C 下的叶子节点为必检项。

### 最简使用

用户只需要对 WorkBuddy 说：

> 处理待办：任务名称

WorkBuddy应按以下顺序调用：

1. `prepare_todo` 读取任务并匹配SOP。
2. `match_status=matched` 时按P执行；`needs_confirmation` 时在对话中让用户
   从候选SOP中确认；`not_found` 时在对话中说明且保持待办不变。
3. WorkBuddy在对话中处理补充信息、进度、错误和人工步骤。
4. 执行完毕后逐项检查 C，并把全部检查结果传给 `complete_todo`。
5. MCP校验C和SOP版本，通过后移动任务；未通过则拒绝移动。

`complete_todo`具有重复调用保护。任务已经位于「已完成」时不会重复生成。

### AI完善SOP

AI发现C/P缺失时先调用 `propose_sop_improvement`。这个工具只返回建议，不
修改导图。AI必须在对话中展示建议；用户明确同意后，才能把原建议完整传给
`apply_sop_improvement`并设置`user_confirmed=true`。

建议内容、`proposal_id`或SOP版本发生变化时，MCP会拒绝写入。通用
`add_node`、`update_node`、`delete_node`和`replace_tree`也不能绕过保护：
修改SOP时必须先获得用户确认并传`confirm_sop_change=true`。

---

## 3. WorkBuddy（Docker，推荐）

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

## 4. 本地 Node 开发（多端口）

只有在本机用 `启动.bat` 跑 Node 进程时，MCP 才是 `http://主机IP:3847/mcp`。日常给 WorkBuddy 用 Docker 即可。

Cursor stdio 仍用 `.cursor/mcp.json`，协同接口走本机 `127.0.0.1:1234`，需要本机协同服务已启动。

---

## 5. 常见问题

**connect ECONNREFUSED**  
容器或 MCP 没起来。先 `启动-Docker.bat`，再在 WorkBuddy 里点重连。不要用 `127.0.0.1`，不要再用 `:3847`（Docker 模式下是 `:8080/mcp`）。

**WorkBuddy 里看不到工具**  
HTTP 模式只配 `url`，不要配 `command`。用启动脚本打印的地址。

**网页上没同步**  
人必须打开同一 `share_url`（带 `?room=`）。
