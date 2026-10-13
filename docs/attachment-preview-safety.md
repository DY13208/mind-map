# 附件预览的加载边界

2026-10-13 修复：原文件预览和 OCR/文字提取状态分开处理。图片和 PDF 已上传后，即使提取失败，点击附件仍然查看原文件；正在上传的文件继续显示进度。

站内预览默认边界：

| 类型 | 行为 |
| --- | --- |
| 文本、JSON、Markdown | 只读取开头 256 KiB，显示截断提示；下载始终取得原文件 |
| DOCX、表格 | 原文件最多 5 MiB；ZIP 展开体积最多 16 MiB、最多 2000 项 |
| 表格画布 | 最多 10 张表、每表前 500 行/40 列；每次渲染 100 行 |
| 图片 | 最多 16 MiB、2000 万像素；先检查文件头中的尺寸，再交给浏览器解码 |
| PDF | 最多 32 MiB，交给浏览器内置查看器，不在脑图页面复制整份 ArrayBuffer/Blob |

超过边界时停止自动加载，保留原文件下载入口。已有 HTML 附件继续在独立页面打开；外部链接保持原有外部查看行为。

内容接口保留房间权限校验，新增 `max_bytes`、`prefix_bytes` 和 `download=1`。文本前缀通过 COS Range 读取，服务端最高 256 KiB。客户端也对响应流计数，即使旧服务未支持参数或未提供 Content-Length，仍会取消超限读取。关闭窗口立即取消请求，切换附件后旧结果不会写回新预览。

本地验证：图片实际加载、100 MiB 文档不请求正文、文本截断、未知大小的超限流取消、关闭时取消请求、表格分页、浏览器原生下载，以及桌面/390px 预览窗口尺寸。浏览器使用真实渲染器和预览组件，附件 API 使用测试数据；线上 COS/登录环境验收需在部署后进行。

回归命令（从各自包目录运行）：

```sh
# web/
node tests/nodeAttachmentPreview.test.cjs
node tests/nodeAttachmentPreview.component.test.cjs
node tests/boundedAttachmentRead.test.cjs

# simple-mind-map/
node test/attachmentIconState.test.js
node test/nodeKnowledge.http.test.js
node test/nodeKnowledge.test.js
node test/attachmentContentBudget.test.js
```

前端与附件服务需一起更新；上传大小限制及原文件内容不变。
