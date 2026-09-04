# V1 / Yjs 技术债清单

**Do not delete V1/Yjs in this integration.**

| 分类 | Evidence | 处理 |
| --- | --- | --- |
| A. V2 Runtime 仍引用 | `bin/storage.js` persistence/presence Yjs backup paths | Keep |
| B. rollback 仍需要 | `src/plugins/Cooperate.js`, `cooperateYjs.js` | Keep |
| B. V1 测试仍需 | `test/collabYjs.test.js`, old websocket integration | Keep |
| C. 可以安全删除（候选，未执行） | leftover V1 save-status comments in mindApi | Inventory only |
| D. 不确定 | `bin/collabYjs.js`, `bin/mindDoc.js` helpers | Keep |
