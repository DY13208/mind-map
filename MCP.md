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
| `query_nodes` | 按 UID、名称或完整路径定向读取节点、子树、链路或层级；超大结果用游标分页 |
| `list_attachments` | 列出导图（或指定节点）的附件及解析状态，只返回元数据 |
| `read_attachment` | 读取附件正文（服务端已提取的文本，含 PDF/Word/Excel/PPT 与图片 OCR），按字符分页 |
| `upload_attachment` | 把文件挂到指定节点；网页可点击附件图标查看/下载 |
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

### 定向读取大图

不要为定位某个节点而把 `get_map` 的节点上限调大。只要问题涉及某节点、直属子节点、子树、链路或层级，AI 必须使用 `query_nodes`，不得先调用或回退到 `get_map`；`get_map` 仅用于用户明确要求整图概览。它只返回指定范围，`get_map` 原有默认 800、最大 5000 节点的行为不变。

```text
读取「项目 / 研发 / 排期」及其全部子节点：
selector={ type: "path", segments: ["项目", "研发", "排期"] }
scope="subtree"

读取全图第 2 层：
scope="level" level=2 level_mode="absolute"

读取「研发」下第 1 层：
selector={ type: "name", value: "研发" }
scope="level" level=1 level_mode="relative"
```

名称默认严格匹配；同名节点会返回候选 UID 与路径，随后用 UID 重试。`match="fuzzy"` 也只返回候选，不会自动读错分支。单页最多 5000 节点、默认 800 节点，并额外受约 20 KiB 的结果预算约束；返回 `has_more=true` 时，将 `next_cursor` 原样传回继续读取。

用户问某节点的“上下节点”时，不需要整图读取：先用 `path` 取上游链路；目标返回的 `parent_uid` 可继续用 `children` 读取同级节点；对目标本身用 `children` 读取直属下游，或用 `subtree` 读取全部下游。

### 读取附件内容

节点挂了文件时，后端已经把可解析格式的正文提取好存下来了（PDF、Word、Excel、PPT、纯文本/Markdown/HTML，图片走 OCR）。AI 有两条线索能发现附件：

- `query_nodes` 返回的节点 `data` 里带 `attachmentId` / `attachmentName` / `attachmentStatus`
- `get_map format=outline` 的大纲行尾会带 `(附件 合同.pdf att:<id>)` 标记

节点上的 `attachmentExtractedText` 只是截断预览，要完整内容必须用 `read_attachment`：

```text
先看有哪些附件：
list_attachments room_key="demo"                  // 整张导图
list_attachments room_key="demo" node_uid="<uid>" // 只看某个节点

再读正文：
read_attachment room_key="demo" attachment_id="<id>"
read_attachment room_key="demo" attachment_id="<id>" offset=4000 length=4000
```

`read_attachment` 返回：

```json
{
  "ok": true,
  "room_key": "demo",
  "attachment": {
    "id": "a1b2c3",
    "fileName": "合同.pdf",
    "mimeType": "application/pdf",
    "status": "ready",
    "extractedChars": 9000
  },
  "text": "……本次读取的正文片段……",
  "offset": 0,
  "length": 4000,
  "total_chars": 9000,
  "has_more": true,
  "next_offset": 4000
}
```

默认单次 4000 字符、最多 20000 字符。`has_more=true` 时把 `next_offset` 当成下一次的 `offset` 继续读，直到 `has_more=false`。

`status` 不是 `ready` 时不会有正文：`processing` 表示大文件仍在后台解析，稍后重试；`failed` 会给出 `errorMessage`（例如老式 `.doc` 不支持解析，需要人工下载打开）。这两种情况都应如实告知用户，不要编造附件内容。原始文件本身不经 MCP 返回，人类可在网页上预览或下载。

### 挂载附件（产物可点击查看）

WorkBuddy / AI 生成 PDF、Markdown 等产物后，应调用 `upload_attachment`（与网页工具栏「附件」同一套后端），挂到目标节点后会出现**可点击回形针**。

**禁止**只把本机路径、「请拖到节点」、「附件仅客户端可用」写进 `note`/`text`。

```text
本机可读路径（推荐）：
upload_attachment room_key="demo" node="<uid>" file_path="C:/Users/YiRan/WorkBuddy/.../报告.pdf"
# Docker 内会映射到 /workbuddy/... ；OpenClaw output 映射到 /app/output/...

或传文件内容：
upload_attachment room_key="demo" node="<uid>" file_name="报告.pdf" content_base64="<...>"

或可下载 URL：
upload_attachment room_key="demo" node="<uid>" source_url="https://..."
```

成功后节点会带上 `attachmentId`，网页上出现附件图标，点击即可查看/下载。支持 txt/md/csv/pdf/docx/xlsx/html 与常见图片；单文件建议不超过约 24MB。

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
