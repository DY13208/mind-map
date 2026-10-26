# 本机解析性能调优

2026-10-23 的部署配置调整：

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `KB_WORKER_CONCURRENCY` | 3 | 总任务槽位 |
| `KB_LIGHT_CONCURRENCY` | 2 | 轻任务上限 |
| `KB_HEAVY_CONCURRENCY` | 1 | PDF/OCR 等重任务上限 |
| `KB_NATIVE_LIGHT_PARSE` | true | 小型 XLSX、Markdown 跳过 Docling |
| `KB_NATIVE_LIGHT_MAX_BYTES` | 2097152 | 原生快速路径的文件大小上限，2 MiB |

这些默认值由 docker-compose.yml 的 file-kb-worker 服务提供，可用同名环境变量覆盖。独立启动 Node 服务时，config.js 保留原有默认值。

原生 Excel 解析仍执行原有结构化阶段，保留工作表、表头识别和记录入库；Markdown 原文作为解析块保留。TXT 与 XLS 本来就采用原生路径。大于 2 MiB 的 XLSX、Markdown 保留原来的 Docling 路径。

总槽位从 2 提到 3，使一个重任务运行时，最多还有两个轻任务可推进；这不会提高 PDF/OCR 自身的并发上限。

## 本机验证

在当前 4 CPU、6 GiB 限额的 Docling 容器上，对两份约 228/230 KiB、需要 OCR 的现有 PDF 做只读转换，不更新知识库中的解析版本。结果：

- 首轮串行：59.48 秒，包含模型首次加载影响。
- 双并发：19.07 秒。
- 随后串行：19.05 秒。
- 三轮每个文件的解析正文 SHA256 均一致，转换均成功。

双并发相对预热后的串行没有实际收益，因此保持重任务并发为 1。不能用首次加载后的耗时差声称吞吐量提升，也不能将两个小文件的结果外推为大型扫描件的性能。

测试期间一次资源采样：Docling CPU 约 380%，内存约 1.27 GiB；该采样不是峰值统计。

`services/file-kb/test/native-light-parse.test.cjs` 验证小型 Markdown 正文完整、XLSX 结构化记录保留且不调用 Docling。

后续若要提高 PDF 并发，应先检查 Docling 内部执行器和线程配置，用预热后的相同样本比较批次总耗时，并覆盖大型扫描件和内存峰值。当前不改变上传协议、分片、断点续传或去重行为。

## 回退

将 `KB_WORKER_CONCURRENCY=2`、`KB_NATIVE_LIGHT_PARSE=false`，保留 `KB_LIGHT_CONCURRENCY=2`、`KB_HEAVY_CONCURRENCY=1`，重新创建 worker 即可。已入库文件不会自动重新解析。
