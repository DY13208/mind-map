# 节点展开状态：个人视图

展开状态按登录用户 ID、脑图 roomKey、节点 UID 保存到已有的 `room_user_state.view_state`，不写公共节点表、协同操作或业务撤销历史。不需要新增数据库列。

- `GET /api/files/:roomKey/view-state` 返回 `state.expand` 和服务器维护的 `state.expandVersions`。
- `PATCH` 提交本次改变的 UID（`expand`）以及各 UID 已观察到的版本（`expandBase`），350ms 防抖，同一个页面串行提交。
- PostgreSQL 在事务中创建并锁定用户状态行，逐节点检查版本。不同节点可以合并；过期版本的同节点写入被忽略。返回保存后的状态及版本。旧客户端不传版本的请求仍兼容，升级后的客户端使用版本检查。
- 本地缓存按用户和脑图区分，立即记录视图及待发送日志。网络失败保留日志并重试；刷新/离开页面尝试 keepalive 保存；重新打开时以服务器记录恢复，尚未发送的操作保留原版本，不能覆盖其他设备已保存的新版本。
- 跨设备通过后端记录恢复。其他设备的视图保存不实时广播，不改变当前页面的展开状态。
- 结构变化保留已有 UID 的个人状态，删除的 UID 在恢复时忽略，新 UID 使用系统默认。懒加载树不能用未加载的 UID 缺失来清理历史偏好。
- 进入子脑图的浅层展开仅作为没有历史偏好时的默认；恢复历史选中节点不会展开已折叠的祖先。显式节点定位仍可按原有逻辑展开路径。

验证命令：

```sh
node --test simple-mind-map/test/personalExpandPersistence.test.js
node simple-mind-map/test/personalExpandCommands.test.js
node simple-mind-map/test/fileSystem.test.js
```

新增回归覆盖用户/脑图隔离、同节点冲突、不同节点合并、加载期间操作、串行防抖、离线日志、关闭后的迟到响应、远端结构更新、Yjs 展开命令过滤、个人命令不写业务历史、子脑图默认展开与隐藏选中节点。

PostgreSQL 并发测试需显式设置 `PERSONAL_EXPAND_TEST_PG_PORT`，仅连接 127.0.0.1 上的专用 `cpd_expand_test` 测试库，在独立临时 schema 内运行并清理。正常测试不连接项目生产数据库。

本次浏览器验证使用独立 PostgreSQL 容器及两个测试用户，从 `/files` 卡片进入编辑页：A 折叠后 B 保持展开；A 接收 B 的文本和新增节点后仍折叠；主/子脑图往返、再次进入已折叠子图、刷新均恢复原状态；清空本地偏好并重新登录后仍从后端恢复。展开命令执行前后公共脑图版本均为 7，没有产生新的业务操作。

现有 `http://localhost:8989/files` 入口也已打开检查，自动化浏览器当前显示企业微信登录页；本次没有通过该服务新增或修改现有业务脑图。现有协作服务未重启，后端代码需由正常服务更新流程加载后生效。
