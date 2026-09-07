# Product Shell 预开发验收

验收日期：2026-09-04。基于拉取的 `origin/main`（`7df783c2`），开发分支 `feature/product-shell`。

## 运行方式与边界

- 保留用户提供的根目录 `.env`，使用 `docker compose up -d --build`；没有将 ENV 加入 Git。
- 产品入口：`http://localhost:8989/#/files`；团队入口：`http://localhost:8989/#/spaces`。
- 沿用原认证门禁。浏览器 UI 验收单独拦截 `/api/auth/me` 为测试身份，没有修改认证代码，也没有实际扫码验证。
- 产品元数据是内存 Mock，浏览器整页刷新重置；SPA 页面切换保留。只有视图偏好保存在 localStorage。
- 不提供真实后端 CRUD、分享授权、历史恢复或团队权限。示例 roomKey 并非真实房间凭证。
- 打开脑图复用 `/#/?room=roomKey`。编辑器边界验收拦截了业务 API、Socket.IO 和 WebSocket；只证明路由、挂载与返回，不声称真实协同 E2E 已通过。

## 20 项验收

| # | 要求 | 结果与证据 |
| --- | --- | --- |
| 1 | /files 正常打开 | 通过：文件夹、4 张初始 Room 卡片、工具栏与 Mock 提示显示 |
| 2 | 左侧导航 | 通过：六个导航入口逐一切换 |
| 3 | 最近 | 通过：使用 lastOpenedAt 范围与默认排序 |
| 4 | 收藏 | 通过：新增收藏后进入收藏页可见；取消收藏服务测试通过 |
| 5 | 共享 | 通过：Owner、我的角色与协作者显示 |
| 6 | 回收站 | 通过：删除项显示原位置，恢复/永久删除仅更新 Mock；清空后显示空状态 |
| 7 | 文件夹进入 | 通过：战略规划面包屑与子列表；新建空目录显示明确空状态 |
| 8 | Card/List | 通过：双视图切换，列表列项与视图偏好 |
| 9 | 搜索 | 通过：Owner 搜索与无匹配状态；实现覆盖标题/Owner/文件夹名称 |
| 10 | 排序 | 通过：名称选项切换，最近更新/最近打开/创建时间排序实现检查 |
| 11 | 重命名 | 通过：产品路线图改名后卡片和历史面板标题同步 |
| 12 | 移动 | 通过：移入战略规划，目录计数从 1 变为 2，进入后可见 |
| 13 | 收藏 | 通过：星标与收藏页联动 |
| 14 | 删除/恢复 | 通过：删除后进入回收站，恢复后从回收站消失；服务测试验证永久删除约束 |
| 15 | Share Dialog | 通过：添加 QA 成员、Viewer 改 Editor、确认移除；按 Room 隔离与头像同步有服务测试 |
| 16 | History Panel | 通过：列表、版本详情、恢复确认及 Mock 成功提示；服务测试确认恢复不修改文档数据 |
| 17 | Team Space | 通过：团队列表/详情/脑图/成员/文件夹；角色修改、成员移除、文件夹筛选 |
| 18 | 打开现有编辑器 | 通过（隔离 smoke）：URL 为 `/#/?room=growth-plan`，编辑器挂载，产品布局卸载 |
| 19 | 不影响现有编辑器 | 路由及编辑器源码未改变；隔离环境下工具栏、根节点可见，返回产品页正常；真实协同未在本线验收 |
| 20 | 不修改 Collaboration Core | 通过：差异限定于产品页面、Mock/Service、产品路由、测试、文档 |

额外检查：创建脑图落入当前文件夹；未知文件夹显示错误和重试；Service 注入一次失败后重试成功；桌面 1440×1000 与小屏 390×844 截图检查，390px 页面 scrollWidth 为 390，无全页横向溢出。

浏览器验收发现并修正：团队成员隐藏标签提前挂载导致 Element UI 下拉滚动条遮挡选项，改为标签懒加载后鼠标点击角色选项通过。产品页面共用命名 chunk 避免新增 CSS 导入顺序警告；共享样式限定于 `.productShell`，小屏品牌图标保持固定宽度。

## Build / Test

- `cd web && node tests/productShell.services.test.cjs`：通过，覆盖 Room/Folder/Share/Team/History 契约、数据隔离、无效参数与错误重试。无数据库/协同网络调用。
- `vue-cli-service lint --no-fix`（新增 JS/Vue 与 router.js）：通过。
- `docker compose up -d --build`：通过；Vue production build 成功，保留 2 项原有包体积警告，无新增 CSS 顺序冲突。
- `git diff --check`：通过。
- 浏览器正常产品页面唯一控制台错误为原站统计脚本 `sdk.51.la/js-sdk-pro.min.js` 的 HTTP 403。编辑器隔离检查时业务 API 的 503 是验收主动拦截，不是产品 Service 请求。
- app/postgres/redis 容器运行且 Docker healthcheck healthy。但 `/api/health` JSON 仍为 `ok:false`，原因是既有 Outbox `pending:1` 积压；该问题交由 Collaboration Freeze 线处理，本线未修改或清理它。
- 未进行生产发布、真实扫码、真实权限/分享、历史数据恢复或多人编辑验收。

本地截图位于 `output/playwright/`（不提交 Git）：`product-shell-files.png`、`product-shell-list.png`、`product-shell-mobile.png`、`product-shell-history.png`、`product-shell-error.png`、`product-shell-editor-boundary.png`。

## 修改文件列表

```text
docs/API_REQUIREMENTS_PRODUCT_SHELL.md
docs/PRODUCT_SHELL_VERIFICATION.md
web/src/router.js
web/src/mocks/folders.js
web/src/mocks/history.js
web/src/mocks/members.js
web/src/mocks/rooms.js
web/src/mocks/teams.js
web/src/services/folderService.js
web/src/services/historyService.js
web/src/services/mockStore.js
web/src/services/productService.js
web/src/services/roomService.js
web/src/services/shareService.js
web/src/services/teamService.js
web/src/pages/ProductShell/FilesPage.vue
web/src/pages/ProductShell/SpacesPage.vue
web/src/pages/ProductShell/SpaceDetailPage.vue
web/src/pages/ProductShell/components/EmptyState.vue
web/src/pages/ProductShell/components/FileSearch.vue
web/src/pages/ProductShell/components/FileSort.vue
web/src/pages/ProductShell/components/FileToolbar.vue
web/src/pages/ProductShell/components/FolderBreadcrumb.vue
web/src/pages/ProductShell/components/FolderCard.vue
web/src/pages/ProductShell/components/HistoryPanel.vue
web/src/pages/ProductShell/components/MoveToFolderDialog.vue
web/src/pages/ProductShell/components/ProductShellLayout.vue
web/src/pages/ProductShell/components/RenameDialog.vue
web/src/pages/ProductShell/components/RoomActionDialogs.vue
web/src/pages/ProductShell/components/RoomCard.vue
web/src/pages/ProductShell/components/RoomList.vue
web/src/pages/ProductShell/components/ShareRoomDialog.vue
web/src/pages/ProductShell/components/TeamCard.vue
web/src/pages/ProductShell/components/TeamMemberList.vue
web/src/pages/ProductShell/components/VersionDetailDialog.vue
web/tests/productShell.services.test.cjs
```

PRODUCT_SHELL_READY = YES（限定本任务要求的 Mock UI 预开发，不代表真实后端已可用）
