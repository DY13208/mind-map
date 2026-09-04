# Collaboration V2 P1 Backlog

| Priority | Item | Reproduction / evidence | Action |
| --- | --- | --- | --- |
| P1 | Renderer Ghost DOM/SVG 计数 | 浏览器 soak 尚未执行 | 建立 Playwright/浏览器计数器后跑 20/50 次矩阵 |
| P1 | Socket listener leak | room open/close 20 次尚未量测 | 集成 harness 输出 listener count |
| P1 | Timer leak | heartbeat/ack/reconnect 生命周期未量测 | unmount 后计数与 heap 快照 |
| P1 | Import/export authoritative reload | 现有普通 import test 未覆盖全部格式 | 在 P0 后补格式矩阵 |
| P1 | V1/Yjs 可删除项 | 当前仅静态分类 | Freeze 后以生产配置验证 |

P1 不阻塞 P0 修复以外的专项工作；本轮未顺手修改业务核心。
