# 通用附件预览

2026-10-14：统一弹窗外壳，按文件类型加载独立预览器；原文件扩展名优先于 MIME，防止提取结果的 Markdown MIME 覆盖原始格式。原有附件元数据、存储、上传和下载接口不变。

## 界面与加载

弹窗为 92vw、最大 1200px、90vh、最大 950px；支持全屏最大化、还原和 ESC 关闭。文件名、大小、类型和操作始终固定在顶部，正文独立滚动。小屏幕收起文档目录，保留必要操作。

| 类型 | 预览与边界 |
| --- | --- |
| Markdown、TXT、JSON、代码 | 响应流每次解码 16 KiB，滚动到底部继续读取；最多预览 8 MiB。Markdown 按完整块渲染、逐步增加目录；代码高亮按块处理。 |
| DOCX | 复用 docx-preview；每批渲染 30 个正文块，大表格按 40 行拆分，保留标题、段落、图片、表格。原文件最多 5 MiB，ZIP 展开最多 16 MiB、2000 项。 |
| Excel / XLS / XLSM / ODS | 复用 XLSX，放到 Worker 中解析。每批传回 100 行，界面仅保留视口与缓冲行。最多 10 张表、每表 10000 行、40 列；原文件及 ZIP 边界同上。 |
| PDF | 自托管 PDF.js 与 Worker；初始 3 页占位，滚动追加 3 页，仅渲染附近页面，远处画布释放。支持翻页、页码定位、50–200% 缩放和适应宽度。最多 32 MiB、2000 页，单页画布最多约 250 万像素。 |
| 图片 | 原文件最多 16 MiB、2000 万像素，先检查文件头尺寸，再解码；适应窗口、25–400% 缩放，关闭释放 Blob URL。 |
| PPTX | 同源加载固定版本 @aiden0z/pptx-renderer 1.3.0，直接解析原文件，每次只渲染当前幻灯片；支持翻页、定位和缩放，不使用提取文字作为预览。最多 5 MiB、200 页；ZIP 展开最多 16 MiB、2000 项。复杂元素按浏览器能力预览，保留原文件下载。 |
| ZIP | 仅读取原文件目录，不展开或执行文件内容；初始显示 100 项，滚动追加 100 项。原文件最多 5 MiB，目录与展开体积预算同 Office；超限可下载。 |
| HTML / 外部链接 | 保留原有独立页面 / 外部查看入口。 |
| 不支持、超限或解析失败 | 清晰显示状态与原文件下载入口，不挂载空白预览器。 |

下载始终走现有 `download=1` 原文件地址，不下载预览截取内容。内容接口仍执行现有权限与大小检查；本次未修改接口。

关闭或切换附件立即销毁子预览器、取消请求和响应流、终止表格 Worker、取消 PDF 渲染、断开观察器并释放图片 URL。请求代次避免旧元数据或旧表格行覆盖当前附件。预览器及解析依赖按需加载；不会在打开脑图时解析附件。

OCR 用于识别图片或扫描 PDF 中的文字，供搜索、知识提取等功能使用。它和原文件查看分开：文件已保存但 OCR 未配置时，上传提示为“已上传，可直接预览”，图标正常；服务端提取状态及其他处理错误保持原有含义。

## 验证与本地演示

从 `web/` 启动 `node scripts/attachmentPreviewDemo.cjs`，打开 `http://127.0.0.1:4321/`。此服务器直接使用生产预览组件、真实脑图节点图标及解析器，附件接口由本地生成的测试文件替代，无 COS 上传和业务数据写入。

测试文件覆盖 Markdown、24 页 PDF、带标题/图片/表格的 DOCX、三张各 2500 行的工作表、OCR 失败图片、35000 行日志、代码、未知格式、100 MiB 文档、慢速响应和 403。实际浏览器验证包括滚动追加、目录/工作表导航、缩放、页码定位、最大化/恢复、ESC、下载和关闭取消。另用隔离数据库启动完整前后端，验证两个客户端编辑保存和实时同步。生产 COS、登录和 OCR 服务需部署后验收。

回归命令：

```sh
# web/
node tests/nodeAttachmentPreview.test.cjs
node tests/nodeAttachmentPreview.component.test.cjs
node tests/boundedAttachmentRead.test.cjs
node tests/attachmentUploadQueue.test.cjs
node tests/nodeAttachmentActions.test.cjs
node tests/sopRunAttachments.test.cjs

# simple-mind-map/
node test/attachmentIconState.test.js
node test/nodeKnowledge.http.test.js
node test/nodeKnowledge.test.js
node test/attachmentContentBudget.test.js
```

构建会复制 PDF.js 字体、CMap、WASM 和 Worker，以及编译表格 Worker 到 `dist/attachment-preview/`。ES 模块以 `.js` 发布以兼容现有 Nginx MIME 配置；部署时随前端产物一起发布，不依赖外部 CDN。Node 构建环境须满足依赖要求（Node >= 20.16；项目 Docker 使用 Node 20）。

图片节点右下角斜箭头：单击查看大图，拖动仍调整尺寸，双击图片保留预览入口。4px 以内的指针抖动按单击处理；拖动在画布缩放后仍保存正确逻辑尺寸。卸载插件清理角按钮和事件。

新增回归：`node simple-mind-map/scripts/verifyImagePreviewGesture.cjs`、`node web/scripts/verifyPresentationPreviewLifecycle.cjs`（仓库根目录）。PPTX 运行库来自 [pptx-renderer](https://github.com/aiden0z/pptx-renderer)，随静态产物发布许可证与第三方说明。
