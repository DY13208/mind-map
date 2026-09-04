# V2 Authority Audit

| Domain | Authoritative source | Evidence | Result |
| --- | --- | --- | --- |
| Tree | `room_nodes` | `bin/roomNodes.js:269-345`、`bin/storage.js:1390-1480` | V2 且表已初始化时唯一权威 |
| Metadata | `rooms.metadata` / `mapMetadata` 正式 store | `bin/mapMetadata.js`、`src/utils/collabMapMeta.js` | 与树分离 |
| Operations | `room_operations` | `bin/storage.js` 的 operation commit/replay | 操作日志权威 |
| `rooms.nodes` | legacy mirror / 迁移兼容 | `bin/storage.js:694-711, 944-978, 1974-2005` | 非初始化 V2 不得 fallback |
| 内存 `room.nodes` | engine graph/cache | `bin/collabV2/engine.js:49-196` | 非 PG authority |

`pickAuthoritativeNodes` 对已初始化 V2 表明确阻止 JSON fallback，并记录 `v2_room_nodes_authority`。仅表未初始化且存在旧 JSON 时允许一次性 `legacy_uninitialized` 迁移。未发现“已初始化 V2 正常打开却按 `rooms.nodes` 选树”的直接证据。

`collabTreeAuthority.test.js` 已随修复后 Freeze 通过，验证内存/模拟存储层面的 authority 选择与 guard；真实浏览器 F5、PG warmup race 仍需集成验证。
