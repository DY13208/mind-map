# 文件知识库保护基线

记录于第一期开发之前。新模块不得修改下列对象。

## 保护的代码

- `simple-mind-map/bin/collabV2/directApplier.js`
- `simple-mind-map/bin/fieldMerge.js`
- `simple-mind-map/bin/roomNodes.js`
- `simple-mind-map/bin/mcpServer.mjs`
- `simple-mind-map/bin/nodeKnowledge/`
- `simple-mind-map/bin/localKnowledge/`
- `simple-mind-map/bin/cogneeSso.js`
- `integrations/knowledge-mcp/`
- `web/src/pages/Edit/`
- `web/src/router.js`
- `docker-compose.yml`
- 根目录 `package.json` 与各现有 `package-lock.json`

## 保护的数据库对象

不新增、不修改这些表、索引和触发器：

- `rooms`
- `room_nodes`
- `room_operations`
- `room_operations_archive`
- `room_outbox`
- `room_snapshots`
- `node_attachments`
- `room_members`
- `auth_sessions`（知识库只做只读会话查找，不更新 `last_seen_at`）

知识库只创建 schema `knowledge`。

## 保护的端口

不监听 1234、3456、3847、8080、8989、3000、15432、16379、18792。

知识库默认：

- API `127.0.0.1:3920`
- MCP `127.0.0.1:3921`
- Docling 由 `DOCLING_SERVE_URL` 指向外部进程，默认不启动

## 页面入口

`web/src/router.js` 的路由是手写数组，没有插件注册表。因此第一期页面只由知识库进程自己提供，不改导航和路由。
