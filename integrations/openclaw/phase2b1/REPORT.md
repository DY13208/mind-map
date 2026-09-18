# Phase 2B-1 Trusted Identity Bridge — 结项报告

日期：2026-09-18（Asia/Shanghai）  
范围：仅身份链（Mind Map Signed Handoff → OpenClaw Liangce Ingress → host-trusted `requesterSenderId`）  
明确未做：Knowledge MCP / OpenWiki 房间化 / Docmost / Cognee 改造

---

## 1. 目标

经 Liangce 助理进入 OpenClaw 的请求，必须把 `requesterSenderId` 落成稳定、主机可信的员工身份 `liangce:<mindMapUserId>`，禁止用 Gateway Token、HTTP body、LLM 参数伪造身份。

## 2. 结论

**Phase 2B-1 = PASS（有残留）**

身份链主路径已实测通过；`who_am_i` 工具曾因 `{ optional: true }` 未进入 agent 可见工具集（代码已改为 `{ name: "who_am_i" }`），gateway 在后续热更新过程中出现反复重建，需运维侧再确认一次稳定加载。  
Cognee memory slot 保持 `cognee-openclaw`，未改动。

## 3. 架构（已实现）

```
WeCom → Mind Map Session → POST /api/openclaw/handoff (Signed JWT, TTL~180s, 无 ACL)
  → Bridge（OPENCLAW_GATEWAY_TOKEN 仅传输鉴权）
  → OpenClaw POST /liangce/inbound (auth=gateway)
  → 验签 handoff → dispatchInboundDirectDm → requesterSenderId=liangce:<userId>
```

禁止：body 自带 `requesterSenderId` / `senderId` / `userId`（返回 `identity_forge_rejected`）。

## 4. 交付物

| 组件 | 路径 |
|------|------|
| Handoff 签发/校验 | `simple-mind-map/bin/openclawHandoff.js` |
| Handoff API | `simple-mind-map/bin/openclawHandoffApi.js` → `POST /api/openclaw/handoff` |
| Collab 挂载 | `simple-mind-map/bin/collabServer.js` |
| Bridge 身份路径 | `scripts/openclaw-bridge/server.mjs`（强制 handoff → `/liangce/inbound`） |
| 前端 handoff | `web/src/utils/openclawGatewayWs.js` |
| Ingress 插件 | `integrations/openclaw/liangce-ingress/` |
| 探针证据 | `integrations/openclaw/phase2b1/inbound-probe.json` |

## 5. 稳定身份格式

- `requesterSenderId = liangce:<mindMapUserId>`
- 同一用户两个 conversation → **同一** `requesterSenderId`
- 会话隔离用 peer id `<userId>::<conversationId>`，不把 conversationId 写进身份

## 6. 实测结果（gateway 健康窗口内）

| # | 场景 | 结果 |
|---|------|------|
| 1 | body 伪造 `requesterSenderId` | **400** `identity_forge_rejected` |
| 2 | User A inbound | **200** `liangce:user-A-test`，reply=PONG |
| 3 | 同 handoff 重放 | **401** `openclaw_handoff_replay` |
| 4 | User B inbound | **200** `liangce:user-B-test` |
| 5 | 同用户另一 conversation | **200** 仍为 `liangce:user-A-test` |
| 6 | 并发 A1/A2/B1 | A1/A2 同为 A；B1 为 B；回复未串话 |
| 7 | fail-closed 探针（无 requester） | **pass=true**，`withoutRequester=null` |
| 8 | Cognee slot | **`cognee-openclaw`**（未改） |
| 9 | `who_am_i` 工具可见性 | **残留**：agent 回报无此工具（当时 `optional:true`）；HTTP 层已证明身份 |

证据文件：`integrations/openclaw/phase2b1/inbound-probe.json`

## 7. 安全属性

1. Gateway Token ≠ 员工身份（仅 HTTP auth）
2. 身份只来自验签后的 handoff `sub`
3. Identity ≠ Authorization（JWT 不含角色/ACL/房间范围）
4. Cron/系统路径 fail-closed（无 requester → resolver 返回 null，无 admin/last-user 回落）
5. jti 防重放

## 8. OpenClaw 加载要点（2026.9.3）

- 插件需写入 `plugins.allow`
- `contracts.tools` 声明后才能 `registerTool`
- 扩展目录：`~/.openclaw/extensions/liangce-ingress`
- `plugins.slots.memory` 必须保持 `cognee-openclaw`

## 9. 残留 / 运维注意

1. **Gateway 反复 Created/Starting**：热更新插件后出现容器被摘掉再重建；请确认 compose/healthcheck/看门狗，并确认 `liangce-ingress` 仍在 `plugins.allow` 且日志含 `[liangce-ingress] ready`。
2. **`who_am_i`**：去掉 `optional:true` 后需在稳定 gateway 上复测「Call who_am_i」。
3. **MCP identity resolver**：`resolverLastSender` 在无真实 MCP 连接时保持 null（预期）；正式 Knowledge MCP 留待后续阶段。
4. 生产 pull/重启仍仅用户操作。

## 10–15. 验收清单对照

10. 双用户 A/B 身份不同 → **PASS**  
11. 同用户双会话身份相同 → **PASS**  
12. 并发隔离 → **PASS**  
13. 无 handoff / 伪造 / 重放 fail-closed → **PASS**  
14. 不碰 Cognee / Knowledge / Docmost / OpenWiki 房间化 → **PASS**  
15. Bridge + 前端已接线 handoff（代码层）→ **PASS**（需在稳定 gateway 上做一次端到端 UI 冒烟）

---

**Phase 2B-1 = PASS（残留：who_am_i 可见性复测 + gateway 稳定性确认）**

Phase 2B-1 完成，等待身份链审核。
