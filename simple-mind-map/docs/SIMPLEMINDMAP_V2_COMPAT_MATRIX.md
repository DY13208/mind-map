# SimpleMindMap V2 Compatibility Matrix

修复后状态：P0 已关闭，Node Freeze 20 个文件全部通过。真实 PG、浏览器 F5 与全格式验证仍未执行，因此该表不是完整兼容性验收证明。“有”表示源码/测试中存在相关路径，不等于真实环境通过。

| Feature | Enabled | Read/Write | Command / Operation | PG | Realtime | Undo / Redo | F5 | Status | Severity | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Core tree insert/move/delete | 是 | RW | `node.insert/move/delete` | 有 | 有 | 有 | 未实测 | Node PASS | - | `collabV2.test`、Move/Delete tests |
| Text/Search replace | 是 | RW | `node.update/batch` | 有 | 有 | 有 | 未实测 | Node PASS | - | `collabV2.test` |
| Paste / cut | 是 | RW | insert/batch | 有 | 有 | 有 | 未实测 | Node PASS | - | Paste tests |
| Node content | 是 | RW | update fields | 有 | 有 | 有 | 未实测 | Node PASS | - | `collabNodeFeatures` |
| Style | 是 | RW | update fields | 有 | 有 | 有 | 未实测 | Node PASS | - | `collabMapMetaStyle` |
| Generalization / OuterFrame / Line | 是 | RW | update | 有 | 有 | 有 | 未实测 | Node PASS | - | Special object tests |
| Theme / Layout metadata | 是 | RW | metadata store | 分离 | 有 | N/A | 未实测 | Node PASS | - | Map meta/layout tests |
| Import / Export | 已启用入口 | RW | import / authoritative export | 有 | 有 | 有 | 待重跑 | 未纳入 Freeze | P1 | Import/Export source audit |
| ACL | 是 | RW | server ACL | 有 | 有 | N/A | 待重跑 | Integration pending | - | ACL integration |
| Same-user multi-client | 是 | RW | distinct clientId | 有 | 有 | N/A | 未实测 | Node PASS | - | `collabV2.test` |

“已启用”表示在当前源代码/菜单存在，不表示本轮所有浏览器、PG 和 F5 场景已验证。不能把 Node PASS 解读为完整专项验收通过。
