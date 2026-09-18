<!-- BEGIN LIANGCE_INJECT -->

## 良策 SOP（Start-Docker 注入 · 勿手改本段）

- 完整输出规则见工作区根目录 `LIANGCE_SOP_RULES.md`（v{{ VERSION }}，与台账 `web/src/utils/sopOutputRules.js` 同源，每次 Start-Docker 覆盖）。
- 跑「制定…目标」类 SOP、写 `output/*.html` 时：主视觉必须是**目标金额看板**（历史 vs 目标、B2B 推导、敏感度/分配）。
- **禁止**把整页做成「GMV 达成进度执行单」壳；禁止「目标金额已填、进度状态列整列红待接入」。
- 「跟踪进度」缺实际数：只对「累计实际 / 完成率」等缺数字段标「待接入」；有日销等替代口径须先算完成率。
- 产物落到 `/home/node/.openclaw/workspace/output/`（宿主机 `./output`）；每次新建带时间戳文件，禁止覆盖历史产物。
- 扩展注入：把文件放进仓库 `docker/openclaw/inject/workspace/`，下次 Start-Docker 会自动 `docker cp` 进本 workspace。

<!-- END LIANGCE_INJECT -->
