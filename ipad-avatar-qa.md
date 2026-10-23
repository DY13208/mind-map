# iPad 头像比例修复验收

基线：2026-10-23 拉取并快进至 `origin/main` 的 `b038da1e0`。修复分支：`fix/ipad-avatar-shape`。

## 原因及修改

在 Chromium 和 WebKit 的 iPad 820×1180 触屏布局中，编辑器右侧头像按钮实测为 34×44，内部头像为 28×28。触屏样式增加了按钮的最小高度和内边距，却沿用了 PC 的 34px 宽度，导致未读消息外圈呈椭圆，头像可用空间也不足。

在 `touch-editor.less` 的编辑器右栏内，将头像徽章和按钮统一为 44×44、按钮采用 border-box 和 6px 内边距，容纳 28px 头像与两侧 2px 边框。PC 的 34px 按钮和通用头像组件保持原有尺寸；点击消息中心、图片错误回退和未读状态逻辑沿用现有实现。

## 自动化验证

使用独立的本地 PostgreSQL QA 数据库、临时登录会话和合成脑图。图片测试使用本地 SVG 数据，无需真实企业微信头像或生产身份。

`web/scripts/testAvatarLayout.cjs` 覆盖 Chromium / WebKit 的以下视口：

| 场景 | 尺寸 |
| --- | --- |
| iPad 竖屏 | 820×1180 |
| iPad 横屏 | 1194×834 |
| iPad Pro 竖屏 | 1024×1366 |
| iPad Pro 横屏 | 1366×1024 |
| iPad 桌面 UA + 触屏 | 820×1180 |
| 分屏 | 744×1133 |
| 手机 | 393×852 |
| PC | 1440×900 |

检查内容：横向/纵向图片等比裁剪、文字头像、图片加载失败及恢复、未读与已读圆形外圈、头像居中、触摸打开/关闭消息中心、旋转后的比例、导航抽屉头像及个人主页入口。手机和窄分屏沿用阅读模式，右侧编辑器菜单保持隐藏。另通过 WebKit 深色主题下的图片与消息入口检查。

复现命令（在仓库根目录，先启动隔离 QA 前后端并创建测试用户与房间）：

```sh
AVATAR_QA_BASE_URL=http://127.0.0.1:8991 \
AVATAR_QA_STORAGE_STATE=/absolute/path/to/qa-auth.json \
AVATAR_QA_ROOM=synthetic-room-key \
node web/scripts/testAvatarLayout.cjs
```

浏览器报告与截图输出至 `output/playwright/ipad-avatar/`。既有脑图列表 ResizeObserver 通知单独计数，其他脚本异常均使测试失败。

本次结果：Chromium 8/8、WebKit 8/8 通过；WebKit 记录 4 条既有 ResizeObserver 通知，其余页面脚本异常为 0。深色主题专项检查通过。

原有检查：头像解析单测、`test:product-navigation`、`test:mobile`、`test:touch-editor`、文件导航及编辑器返回列表回归、变更脚本 ESLint、`git diff --check` 和生产构建。

## 验证边界

本次为浏览器触屏模拟，未替代实体 iPad Safari 和生产企业微信身份验收。构建仍报告主分支已有的 `preferStackedSubmenu` 缺少导出及资源体积警告；本地 Wiki/Knowledge 编译器仍存在已有 `.canonical` 目录 chown 权限错误，未纳入头像修复。正常前端 8989 和 API 1234 的页面/健康检查通过。
