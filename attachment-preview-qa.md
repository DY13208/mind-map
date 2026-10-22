# 附件原文件预览验证

日期：2026-10-22。分支：`fix/mobile-reader-circle-menu`，合并最新 `origin/main` 基线 `695c213fb`。

## 修复范围

有附件 ID 的 CSV 已使用工作表预览；只有 URL 的旧附件此前始终嵌入 iframe，CSV 会显示为逗号文本。现在旧 URL 的 CSV/TSV、工作簿、DOCX、PPTX、PDF 进入对应原文件解析器。HTML 和其他外部链接保留既有打开方式。

外部文件读取沿用流式大小限制，不把应用 Cookie 发送给其他域名，关闭预览会取消读取。外链 HTTP 错误、网络或跨域限制会显示明确提示，并保留外部打开入口；不会把错误页面当成文件内容。已有 ID 附件继续走原鉴权接口。

## 验证

- 原附件预览、CSV/TSV 编码与工作簿、图片与缩略图、PPTX 生命周期检查通过。新增外链路由、URL 文件名、HTTP/CORS 错误、取消、大小限制及原鉴权接口回归通过。
- 真实组件的独立样例服务器在 Chromium/WebKit 各覆盖桌面、手机、iPad：CSV、GBK CSV、TSV、XLSX/XLS/XLSB/ODS、空 CSV、DOCX、PDF、PPTX、Markdown、ZIP、音频以及错误与慢速取消。
- 实际 Vue 应用和本地独立鉴权会话中，分别验证 ID 附件和旧 URL 两条路径：CSV 单元格内容逐项一致；中文、前导零和单元格内逗号/换行保留；24 页 PDF 实际绘制文字、翻到第 2 页、125% 缩放；3 页 PPTX 显示第 2 页实际内容，缩放保留页码和内容。两种浏览器、3 个视口，共 12 个场景通过，无未捕获页面错误或预览静态资源加载错误。
- 浏览器网络失败显示提示，外部打开按钮派发正确原地址，随后打开正常 CSV 成功。
- 合并后的胶囊标题栏、返回目录、切换文件、长标题和失败状态入口在 Chromium/WebKit 各 5 个触摸视口回归通过；移动端手势和文件列表脚本通过。
- ESLint、生产构建和 Git 空白检查通过。

本地证据位于 `output/playwright/attachment-latest/`、`output/playwright/attachment-external/`、`output/playwright/reference-editor/preview-report.json` 与 `output/playwright/capsule-header/header-report.json`，不提交二进制截图。

## 验证边界

浏览器原文件响应来自本地测试样例，应用会话与协作数据使用独立本地 PostgreSQL；生产 COS、生产用户附件及物理设备尚未验收。外链需要允许浏览器读取；未开放跨域时使用外部打开。沿用现有预览上限：Office/PPTX 5 MiB、PDF 32 MiB，压缩文档展开大小和页数也有限制。复杂幻灯片字体、特效或部分元素可能与原应用不同，界面保留原文件入口。
