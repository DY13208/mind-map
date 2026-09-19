<!-- BEGIN LIANGCE_INJECT -->

## 良策 SOP（Start-Docker 注入 · 勿手改本段）

- 完整输出规则见工作区根目录 `LIANGCE_SOP_RULES.md`（v{{ VERSION }}，与台账 `web/src/utils/sopOutputRules.js` 同源，每次 Start-Docker 覆盖）。
- 跑「制定…目标」类 SOP、写 `output/*.html` 时：主视觉必须是**目标金额看板**（历史 vs 目标、B2B 推导、敏感度/分配）。
- **禁止**把整页做成「GMV 达成进度执行单」壳；禁止「目标金额已填、进度状态列整列红待接入」。
- 「跟踪进度」缺实际数：只对「累计实际 / 完成率」等缺数字段标「待接入」；有日销等替代口径须先算完成率。
- **制定全渠道GMV目标**：主表用「2026销售日报表」做年化×定位推算，必须出敏感度三档 + B2B 五部门推导 + 补量分配；BY26 排产表只可交叉校验，禁止整表 dump（禁止只贴 173700000 这类表内原值交差）。
- 产物落到 `/home/node/.openclaw/workspace/output/`（宿主机 `./output`）；每次新建带时间戳文件，禁止覆盖历史产物。
- **附件挂载（等同网页工具栏「附件」）**：产物生成后必须调用 MCP `upload_attachment` 挂到目标节点，使节点出现可点击回形针；**禁止**只写本机路径 /「请拖到节点」/「附件仅客户端可用」到 note。`file_path` 优先用 output 或 WorkBuddy 目录下的实际文件；失败则改 `content_base64`。
- 扩展注入：把文件放进仓库 `docker/openclaw/inject/workspace/`，下次 Start-Docker 会自动 `docker cp` 进本 workspace。

<!-- END LIANGCE_INJECT -->
