# Full Tree Mutation Audit

| Classification | Location | Reason |
| --- | --- | --- |
| Allowed | `src/plugins/Cooperate.js:3332-3338` | `IMPORT_APPLYING` 中 `setFullData` |
| Allowed | `src/plugins/Cooperate.js:3490-3559` | import/recovery 的受控 replace |
| Allowed | `bin/mindApi.js:1854-1998` | `map.replace` slow path，限定 import/version restore/recovery |
| Allowed | `bin/storage.js:944-978,1378-1436` | 一次性 legacy migration/repair |
| Guarded forbidden | `src/plugins/Cooperate.js:1974-1987` | 普通远端 operation 禁止 full tree apply |
| Guarded forbidden | `src/core/render/Render.js:223-235` | Undo/Move 的 `Render.setData` guard |
| Guarded forbidden | `src/plugins/Cooperate.js:4867-4890` | Paste Undo 禁止 `map.replace` |

普通 Text、Style、Move、Delete、Paste、Theme/Layout、Search/Replace、Generalization 与 AssociativeLine 均不得产生 `map.replace`。`index.js` 的通用 `setData/setFullData` 是基础 API，不能脱离调用场景判错。现有 `collabMove`、`collabGeneralization`、`collabPasteUndo`、`collabTreeAuthority` 已覆盖关键 guard，并在 P0 修复后随 Freeze 全部通过。
