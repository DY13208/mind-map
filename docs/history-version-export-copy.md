# 历史版本导出与分支复制

## 使用范围

历史版本列表的“导出此版本”导出整个指定版本，使用原画布的八种格式及选项。
历史预览支持单选、Ctrl/⌘ 多选、框选和“复制选中分支”；复制包含折叠的全部后代。
关闭历史弹窗后，在当前画布选择父节点，再通过已有粘贴入口插入新节点。
这项能力不会自动替换当前分支，不增加分支导出或局部恢复接口。

图形导出沿用历史数据中的展开状态；预览的概览折叠、分页和缩放不影响导出。
结构化导出保留完整树。历史未记录的展开字段使用已有默认值，不还原个人缩放和平移。
附件沿用原画布导出/复制的引用语义，不下载、打包或恢复附件文件。

## 兼容接口

- 脑图库 `allowReadonlySelection: false` 为默认值。启用时允许只读画布的 Ctrl/⌘ 多选与框选；原有只读单击选择保持不变。写命令仍受 `readonly` 限制。
- 导出组件可选 `managed`、`executeExport(request)`、`defaultFileName`；默认入口继续沿用原有事件方式。
- 导出请求包含 `type`、`fileName`、`withConfig`、`isTransparent`、`isFitBg`、`paddingX`、`paddingY`、`extraText`。
- 历史复制使用现有 `{ simpleMindMap: true, data: [...] }` 结构，粘贴后生成新 UID 并重映射复制集合内的关联线。
- 应用内复制缓冲只服务同一脑图，在普通有效复制/剪切后失效，页面刷新后不保留。可读取的系统剪贴板内容优先。

历史导出通过现有版本树读取接口获取完整数据，不新增数据库字段、迁移或服务。
临时导出实例独立加载插件、处理参数并清理资源，不连接协同，不修改当前画布。

## 回归入口

```powershell
node web/scripts/historySnapshotCheck.cjs
node web/scripts/historyClipboardCheck.cjs
node web/scripts/historyPanelCheck.cjs
node web/scripts/historyExportCheck.cjs
node simple-mind-map/scripts/readonlySelectionCheck.cjs
```

浏览器脚本使用已有 Playwright 运行环境，必要时通过 `NODE_PATH` 指向其包目录，不要求新增项目依赖：

```powershell
node web/scripts/historyCopyBrowserCheck.cjs
node web/scripts/historyExportBrowserCheck.cjs
node web/scripts/historyPanelBrowserCheck.cjs
```

产物和截图写入 `output/`。自动化检查与最终人工验收分别记录。

## 本次验证记录（2026-10-13）

- 数据提取、缓冲与粘贴、受控导出组件、固定版本/请求取消、只读选择的专项检查通过。
- 浏览器验证覆盖真实选择与快捷键复制、完整折叠子树、未展示根分支、新 UID、内部关联线、剪贴板权限拒绝回退、外部内容优先及关闭后的监听清理。
- 八种格式均完成下载验证；SMM/JSON 下载文件在独立画布重新载入，完整树及主题配置保持。图形导出保留折叠状态。
- 完整弹窗验证：预览 A 时导出 B，文件包含 B 的全部后代；取消/关闭不下载，普通导出入口未误触发。
- 失效节点图片及背景图片、取消后的迟到结果、全局插件隔离和临时实例清理均通过。资源等待超时会明确失败，不下载不完整结果。
- 17 项既有复制、撤销、懒加载选择、选择缓存、概要选择和导出回归通过，日志为 `output/history-phase1-regression.log`。
- 最终前端构建通过，目录为 `output/history-phase1-final-build`，日志为 `output/history-phase1-final-build.log`；仍有 CSS 顺序、包体积等构建警告。
- `codegraph sync`、`codegraph status` 和 `git diff --check` 通过。

额外运行的旧本地 `web/tests/contextmenu.component.test.cjs` 在概要添加的模拟节点断言上失败。
该脚本将依赖全部替换为模拟对象；它读取的 `Contextmenu.vue` 与 HEAD 的 Git 对象哈希相同，未在本次修改。
此失败单独保留，没有扩大本次范围去修改右键菜单行为或旧夹具。

代码交付时未部署、未重启服务、未提交或推送，未操作业务数据库。最终人工验收仍需在专用测试脑图完成。
浏览器截图：`output/playwright/history-phase1/history-panel.png`、`history-copy.png`；下载日志为同目录 `history-export.log`。

## 本地启动记录（2026-10-13）

按用户要求通过现有 Compose 重新构建镜像，仅重建并启动 `mind-map-app-1`。
验收入口为 `http://localhost:8990/files`；`/api/health` 返回 `ok=true`，Redis 总线正常，无健康告警。
已确认容器静态资源包含“导出此版本”和“复制选中分支”，复制模块与本地源码 SHA256 一致。

保留既有数据库、Redis、其他服务和原有数据挂载；当前 Compose 另外挂载了既有本地知识目录及其缓存卷。
没有数据库字段变化。合入主分支带来的迁移 `009` 已在本地 `mind_map` 库按原脚本于事务外执行，新增归档操作 ID 非唯一索引，`indisvalid`、`indisready` 均为 true；没有修改业务记录。

镜像构建日志：`output/history-phase1-local-rebuild.log`；启动日志：`output/history-phase1-local-start.log`。
未提交或推送。此记录只确认本地服务就绪，最终人工验收由用户完成。

## 同步主分支后的复验（2026-10-13）

在 `codex/hx-dev` 上以自动暂存保护本次修改，将主分支从 `d5793106` 快进同步至 `45978ccd`（7 个提交），无冲突，原有修改完整恢复。
五组专项脚本、17 项既有回归、三个浏览器检查（含八格式导出）及独立前端构建全部通过。
构建产物为 `output/history-phase1-postmerge-45978ccd`，日志为 `output/history-phase1-postmerge-verify.log` 和 `output/history-phase1-postmerge-build.log`。
CodeGraph 和差异检查通过。提交范围限定为本功能的源码、验收脚本和本文档；输出产物及其他未跟踪文件保留在本地。
本次 Git 同步不重启本地容器，当前运行环境仍为上一节记录的本地构建。
