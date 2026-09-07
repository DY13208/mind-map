# Debug / Trace Inventory

Do not mass-delete traces in this integration.

| 分类 | 位置 | 建议 |
| --- | --- | --- |
| Production guard 必须保留 | `bin/roomNodes.js`、`bin/storage.js` tree-authority | Keep |
| Freeze diagnostic | `bin/collabV2/trace.js`、adapter/sequencer `COLLAB_V2_TRACE` | Keep, ring-buffer |
| Test only | `TEST_HANG_TRACE` in `collabV2.test.js` + suite runner timeout | Keep in tests |
| Future removable | leftover `console.*` in mindApi/collabServer | Later |
