# iPad 头像比例修复验收

基线：2026-10-23 拉取并快进至 `origin/main` 的 `b038da1e0`。修复分支：`fix/ipad-avatar-shape`。

## 原因及修改

第一轮修复解决了头像按钮 34×44 的宽高不一致，但只检查了较高的 iPad 视口和按钮本身的尺寸，遗漏了祖先滚动容器的裁切。

用户补充的 1278×608 截图在 WebKit 中可复现：右侧菜单发生纵向滚动时，44px 菜单被滚动条占去 7px，内部可用宽度仅 37px；44px 头像按钮居中后向左溢出 3.5px，外圈、光晕和红点也超过裁切边界。Chromium 即使没有滚动条占位，44px 外圈的 3px 光晕也会被裁切。

最终修改：

- 将头像的 34px 视觉外圈从按钮中独立为 `notificationAvatarFrame`，内部头像仍为 28px；iPad 的点击区域为 44×44，给外圈的 3px 光晕保留空间。
- iPad 右栏隐藏滚动条外观，保留原生纵向滚动，避免 Safari 压缩菜单内容宽度。PC 的滚动条样式不变。
- 将触屏未读红点放在按钮内部，红点自身不拦截点击；键盘焦点框也放在可见范围内。消息状态、图片回退和鉴权逻辑沿用现有实现。

## 自动化验证

使用独立的本地 PostgreSQL QA 数据库、临时登录会话和合成脑图。图片测试使用本地 SVG 数据，无需真实企业微信头像或生产身份。

几何回归使用本地系统回退字体，隔离 Google Fonts CDN 加载时延；产品的字体加载策略未修改。Chromium 原生触摸测试在输入前激活当前测试页，并随上下文关闭 CDP 会话，避免提前 detach 导致浏览器清除触摸模拟。

`web/scripts/testAvatarLayout.cjs` 覆盖 Chromium / WebKit 的以下视口：

| 场景 | 尺寸 |
| --- | --- |
| iPad 竖屏 | 820×1180 |
| iPad 横屏 | 1194×834 |
| iPad Pro 竖屏 | 1024×1366 |
| iPad Pro 横屏 | 1366×1024 |
| 用户截图同尺寸 | 1278×608 |
| 同尺寸桌面 UA + 触屏 | 1278×608 |
| iPad 桌面 UA + 触屏 | 820×1180 |
| 分屏 | 744×1133 |
| 手机 | 393×852 |
| PC | 1440×900 |

检查内容：横向/纵向图片等比裁剪、文字头像、图片加载失败及恢复、未读与已读圆形外圈、头像居中、外圈及光晕/红点在祖先可视范围内、点按红点打开/关闭消息中心、旋转后的比例、导航抽屉头像及个人主页入口。短视口额外检查菜单与缩放按钮不重叠、菜单滚动及收起/展开。Chromium 使用原生触摸滑动；WebKit 桌面 UA + 触屏使用原生滚轮，移动模拟因 Playwright 不提供原生滑动/滚轮接口，使用程序化滚动检查可见性和后续点击。手机和窄分屏沿用阅读模式，右侧编辑器菜单保持隐藏。

复现命令（在仓库根目录，先启动隔离 QA 前后端并创建测试用户与房间）：

```sh
AVATAR_QA_BASE_URL=http://127.0.0.1:8991 \
AVATAR_QA_STORAGE_STATE=/absolute/path/to/qa-auth.json \
AVATAR_QA_ROOM=synthetic-room-key \
node web/scripts/testAvatarLayout.cjs
```

浏览器报告与截图输出至 `output/playwright/ipad-avatar/`。既有脑图列表 ResizeObserver 通知单独计数，其他脚本异常均使测试失败。

修改前后的同尺寸截图和几何数据位于 `output/playwright/ipad-avatar-clipping/`，其中 WebKit 的菜单可用宽度从 37px 恢复为 44px，菜单横向内容宽度也为 44px。

补修结果：Chromium 10/10、WebKit 10/10 通过，深色短视口专项检查通过；既有 ResizeObserver 通知记录 6 条，其他页面脚本异常为 0。生产构建及上述原有回归检查均通过。

原有检查：头像解析单测、`test:product-navigation`、`test:mobile`、`test:touch-editor`、文件导航及编辑器返回列表回归、变更脚本 ESLint、`git diff --check` 和生产构建。

## 验证边界

本次为浏览器触屏模拟，未替代实体 iPad Safari 和生产企业微信身份验收。构建仍报告主分支已有的 `preferStackedSubmenu` 缺少导出及资源体积警告；本地 Wiki/Knowledge 编译器仍存在已有 `.canonical` 目录 chown 权限错误，未纳入头像修复。正常前端 8989 和 API 1234 的页面/健康检查通过。
