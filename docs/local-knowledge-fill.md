# 资料补齐与 MinerU 在线解析

Wiki 优先检索；无结果、未匹配或字段为空时使用配置资料目录的后台索引。所有字段在已有明确、符合目标实体/字段的原文且已读取资料无冲突时直接补入，不等待全部文件解析，也不要求第二次确认。待处理、未支持及失败文件作为资料不完整提示，不单独阻止有效事实。无有效原文、已知冲突、权限失败或资料版本变化时不写入。

## 格式与配置

在后端 .env 设置 LOCAL_KNOWLEDGE_ROOT 和 MINERU_API_TOKEN。Token 不写入前端或日志。开发者登录使用服务验证的账号身份；所有已登录的用户账号均可使用共享资料补齐，但必须拥有当前脑图编辑权限；匿名和服务账号不能使用。Compose 只读挂载根目录，独立缓存卷保存索引及任务，更换目录/凭据后重新创建 app。

PDF、PNG/JPG/JPEG/JP2/WebP/GIF/BMP、DOC/DOCX、PPT/PPTX、XLS/XLSX 统一通过官方精准 API 使用 vlm；HTML 使用 MinerU-HTML。TXT、Markdown、CSV、TSV、JSON 本地读取。格式与模型由 formats.js 统一映射，不能将本地 MinerU 支持的格式视为在线 API 可用。RAR 等压缩包不展开。单文件保留 50 MB 限制；云端超限/额度/转换失败明确提示，不自动截取页面，也不降级为没有资料。

## 索引和缓存

启动后后台索引，每分钟检查变更；点击补齐直接查询缓存。文件并发最多 2，优先当前字段主要材料、当前公司其他文件、全目录后台，同级 FIFO。已有 PDF/图片 MinerU 缓存复用；新增格式以及旧 DOCX/XLSX 本地缓存按解析器键重新处理。公司与字段事实缓存保存至独立缓存卷，文件修改/删除后失效。

mineru-tasks 保存匿名内容指纹、任务 ID 和结果；重启恢复任务，同文件不重复上传。任务超时 20 分钟后保留状态以便恢复，签名地址过期则重新申请。API Token 只发送给官方任务接口，不发送给上传/下载地址。结果压缩包限制大小并拒绝路径穿越、非公网 HTTPS 地址。

## 接口和写入

POST /api/local-knowledge/fill 只接受 roomId、titles、existingTexts、mode（preview/commit）与 revision，不接受文件路径。返回 NDJSON 状态和 result，含 previewTrees、trees、sources、coverage、revision、canCommit、incomplete、timings。preview 始终不返回插入 trees；commit 根据最新版本和已有原文返回可插入树。字段自动补齐先查询缓存，再自动提交所见版本；版本变化则更新结果重新检索。

写入前重新读取未展开子节点并去重，检查脑图权限、资料版本、节点路径与取消状态。姓名不能由法人/签署人推断，分公司不能套用总公司事实；日期和币种保留，变更前资料不能推断为当前状态。新增节点不写 note，保留无图标 autoFill 标识；sources/evidence 保留相对文件名、原文、提取方法及可靠定位，没有页码时明确标记缺失。

部分资料写入后面板继续每 5 秒后台核查；后来发现冲突或更多原文只提示，不自动覆盖、删除或追加。关闭面板停止查询及尚未发生的自动写入，共享解析继续。系统不宣称资料完整。GET /api/local-knowledge/status 和 POST /api/local-knowledge/refresh 供登录用户查询/刷新索引；刷新接口同样校验脑图编辑权限。

LOCAL_KNOWLEDGE_SHAREHOLDER_NAMES 可设置“完整公司名 → 原文姓名 → 已确认姓名”，只修正展示并保留原文。旧自动标记清理仍使用历史备份和协作命令，保留手写内容/备注/附件/独立子节点，不修改原文件。

经营许可只补明确许可/备案名称及编号（或明确完成办理的原文），有效期只能附在相邻已识别证书信息后；不把地址、服务器字段、经营范围长段、独立日期、URL、页码当作许可。原文仍完整保留在 sources 中。字段匹配缓存按规则版本更新，不重复上传已有正文。无独立公司资料、无有效匹配、已存在内容及已知冲突会结束本次请求并提示；只有待处理的相关资料才继续查询。所选经营许可节点下可确认的自动噪声，在历史备份和并发检查后修复，手写内容/备注及附件/子节点保留。

资料补齐不再依赖系统管理员名单配置。现有管理员配置仍负责系统其他全局权限，不会因开放补齐而提升普通账号的脑图权限。


## 多资料目录

原来的 `LOCAL_KNOWLEDGE_ROOT` 继续支持。多个目录配置为 JSON 数组，`LOCAL_KNOWLEDGE_ROOTS` 优先：

```env
LOCAL_KNOWLEDGE_ROOTS=["D:/公司资料","E:/商标资料"]
```

原生后端直接读取上述目录。Docker 内部不能直接访问 Windows 路径，先生成只读挂载配置：

```powershell
node scripts/local-knowledge-compose.cjs
docker compose -f docker-compose.yml -f .secrets/local-knowledge.compose.json up -d --no-deps app
```

构建仍使用 `docker compose build app`。后续每次启动/更新都需带上这个 override；目录修改后重新运行生成脚本。生产主机使用生产主机实际目录，不能沿用开发机路径。生成文件只留本机，不加入 Git。

多个根目录来源带“资料目录1/2…”前缀，各目录独立持久缓存；全部目录统一做冲突和去重，总解析并发最多两个文件。配置中的资料会按现有规则提交 MinerU。不要同时配置父目录和它的子目录，以免重复收录；一个上级目录已递归覆盖所有子目录。资料文件仍为只读，不回写。
