# Product Shell API Requirements

本文只描述产品外壳未来需要的请求与响应 DTO，不定义数据库表、协作协议或 ACL 判定实现。当前页面使用 `web/src/services/` 下的 Mock Implementation；接入后端时保持 service 方法签名，仅替换实现。

## 通用约定

- 列表请求支持 `cursor`、`limit`、`query`、`sort`、`order`，响应包含 `items` 与可选 `nextCursor`。
- 时间使用 ISO 8601；ID/roomKey 均视为不透明字符串。
- 错误响应需要稳定的 `code`、可展示的 `message` 和可选 `requestId`。
- 成员角色 DTO 使用 `Owner | Editor | Viewer`，最终权限仍由现有 ACL 核心判定。

## Room

- `listRooms({ scope, folderId, query, sort, order, cursor, limit })`：返回卡片/列表所需的 `id, roomKey, title, owner, collaborators, role, favorite, folder, createdAt, updatedAt, lastOpenedAt, deletedAt`。
- `getRoom(id)`：返回 Room 产品元信息，不包含脑图节点内容。
- `createRoom({ title, folderId? })`：返回新 Room 的 `id, roomKey, title, folder, owner, createdAt, updatedAt`。
- `renameRoom(id, { title })`：返回更新后的 `title, updatedAt`。
- `moveRoom(id, { folderId })`：`folderId = null` 表示根目录，返回更新后的 `folder, updatedAt`。
- `toggleFavorite(id, { favorite })`：返回 `favorite, updatedAt`。
- `deleteRoom(id)`：软删除，返回 `deletedAt`。
- `restoreRoom(id)`：返回 `deletedAt: null, folder`。
- `permanentDelete(id)`：返回 `{ ok: true }`，服务端负责权限与二次校验。

## Folder

- `listFolders({ parentId?, teamId?, query? })`：返回 `id, name, parentId, roomCount, updatedAt`。
- `createFolder({ name, parentId?, teamId? })`：返回文件夹 DTO。
- `renameFolder(id, { name })`：返回更新后的文件夹 DTO。
- `deleteFolder(id, { roomDisposition })`：支持将内容移到根目录；返回 `{ ok: true }`。
- `moveFolder(id, { parentId })`：未来启用多级目录时使用。

## History

- `listVersions(roomId, { cursor, limit })`：返回 `id, version, revision, createdAt, operator, note, type, summary`。
- `getVersion(roomId, versionId)`：返回版本详情与未来预览能力标识；真实 diff/快照格式由后端后续定义。
- `restoreVersion(roomId, versionId)`：返回新生成的版本信息。恢复由后端和协作核心统一实现，前端不会直接 `map.replace`。

## Team

- `listSpaces()`：返回 `id, name, description, owner, memberCount, roomCount, updatedAt`。
- `getSpace(id)`：返回团队信息及当前用户角色。
- `listMembers(id)`：返回 `id, name, avatar, email/userid, role, joinedAt`。
- `listRooms(id, query)`：返回标准 Room 列表 DTO。
- `updateMemberRole(spaceId, memberId, { role })`、`removeMember(spaceId, memberId)`：服务端负责权限判断。

## Share

- `getMembers(roomId)`：返回共享成员及角色。
- `addMember(roomId, { emailOrUserId, role })`：返回新增成员 DTO。
- `updateMemberRole(roomId, memberId, { role })`：返回更新后的成员 DTO。
- `removeMember(roomId, memberId)`：返回 `{ ok: true }`。

## 等待后端接入

1. 产品元数据分页、搜索和排序。
2. 文件夹层级及移动规则。
3. 最近、收藏、回收站的持久化语义。
4. 历史版本真实列表、预览、diff 与恢复。
5. 团队空间和成员管理。
6. 分享成员管理与现有 ACL 的统一授权。
7. Loading/Error 对应的标准错误码和重试策略。

## 当前前端 Service Interface（可直接替换实现）

所有方法返回 Promise；调用方仅使用以下接口，不导入 mock 数据。

| Service | 方法签名 |
| --- | --- |
| roomService | `listRooms({favorite?, shared?, trash?, recent?, role?, folderId?})`, `getRoom(id)`, `createRoom(title, folderId?)`, `renameRoom(id, title)`, `markOpened(id)`, `toggleFavorite(id)`, `deleteRoom(id)`, `restoreRoom(id)`, `permanentDelete(id)` |
| folderService | `listFolders()`, `createFolder(name)`, `renameFolder(id, name)`, `deleteFolder(id)`, `moveRoom(roomId, folderId)` |
| historyService | `listVersions(roomId)`, `getVersion(roomId, versionId)`, `restoreVersion(roomId, versionId)` |
| teamService | `listSpaces()`, `getSpace(id)`, `listMembers(spaceId)`, `listRooms(spaceId)`, `listFolders(spaceId)`, `updateMemberRole(spaceId, memberId, role)`, `removeMember(spaceId, memberId)` |
| shareService | `getMembers(roomId)`, `addMember(roomId, emailOrUserId, role?)`, `updateMemberRole(roomId, memberId, role)`, `removeMember(roomId, memberId)` |
| productService | `getProfile()` |

当前搜索、排序、角色过滤在产品层进行；后端接入时可将这些参数下沉至 service。Mock 使用内存副本，刷新页面重置；卡片/列表视图偏好单独存于 `product-shell-view`。成员数据按 roomId / spaceId 隔离，历史版本按 roomId 隔离。一级文件夹删除后将内容移至根目录，团队归属不随文件夹移动改变。

路由保留原 Vue Router hash 模式，实际访问 `/#/files`、`/#/spaces`，编辑器仍为 `/#/?room=roomKey`。Mock Room 打开前会提示：仅跳转原编辑器，不传入节点、版本或权限数据；进入后的认证、真实文件存在性和协同流程由原编辑器处理。

### 边界

此交付不定义最终数据库表、不调用真实分享或历史恢复接口，不产生节点/operation 写入。`TODO_API_REQUIRED` 仅为版本真实预览、差异渲染与后端恢复能力；它不阻塞 Mock 产品外壳验收。未来的正式 ACL 判定不能放入这些组件或 Mock service。
