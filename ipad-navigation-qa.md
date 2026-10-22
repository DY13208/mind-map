# iPad 左侧导航与全部功能菜单

日期：2026-10-22。基线：最新拉取的 `origin/main`，`e9d39d5c2`。分支：`fix/ipad-file-menus`。

## 行为

按用户确认，修改左侧导航和“全部功能与设置”，不调整脑图卡片的操作菜单。

- 以触摸能力和可用宽度识别 iPad，兼容 iPad 桌面 UA、横竖屏与分屏；PC 保留原有侧栏展开方式。
- 未保存侧栏偏好时，窄幅触控布局默认使用紧凑侧栏。用户已有偏好仍然生效；打开触控导航面板不改写侧栏偏好。
- iPad 收起状态显示明确的展开图标，点击后可在完整模式打开导航面板，不依赖鼠标悬停。
- 面板复用 PC 的导航分组、图标、路由及选中状态，补齐消息中心、个人主页和退出确认入口。触摸按钮和菜单项目至少 44px。
- 内容区可滚动，标题与账户区域固定；支持遮罩、关闭按钮、Escape、焦点返回和 Tab 循环。侧栏与弹层使用不同导航 ID。
- 个人主页跳转保留当前 shell 模式，消除原路径触发的重定向异常。

## 验证

- Chromium / WebKit，8 种视口，各覆盖 full / focus 模式：1440×900、1024×768（PC）、820×1180、1194×834、1024×1366、1366×1024、744×1133、393×852。检查展开与关闭、44px 点击区域、菜单边界、唯一 ID、收藏页跳转及模式保持。PC 完整模式确认仍然展开内联侧栏。
- 两种浏览器验证遮罩与 Escape 关闭、焦点恢复与 Tab 循环、点击当前页面、消息中心、个人主页、退出后取消且会话保留、旋转和短窗口滚动。
- iPad 桌面 UA、深色模式检查通过。深色消息入口颜色与导航文字一致；Chromium 原生触摸滚动和 WebKit 滚动边界检查通过。
- `test:product-navigation` 验证触控入口、PC 行为、偏好隔离、模式保持及监听清理；shell/file-navigation/editor-return 共 25 项检查通过，移动端原有 27 项回归通过。
- 修改文件 ESLint、生产构建及 Git 空白检查通过。

本地证据：`output/playwright/ipad-navigation/`，包括 layout-report.json、flow-report.json、before/after 截图和 final-dark-webkit.png。

## 边界与既有通知

WebKit 旋转过程中出现 `ResizeObserver loop completed with undelivered notifications`。使用未修改主分支的独立源码实例 8992 对照：主分支与本次版本相同旋转序列各出现 36 次通知，观察目标均为 `roomCard gf-root`。导航功能检查保留这类既有通知的计数，不将其当成本次新增异常；未发现其他页面异常。对照证据在 resize-instrumentation.json，本次不修改卡片尺寸监听。

验证使用独立本地 PostgreSQL 和测试用户，未操作生产用户数据。退出仅验证取消流程；真实 iPad 硬件和生产身份提供方未现场验收。
