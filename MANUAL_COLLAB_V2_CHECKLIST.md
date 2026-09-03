# Collaboration V2 人工验收清单

用两个普通浏览器窗口（A / B）打开同一张图。只通过界面操作，不要打开开发者控制台，不要改数据库，不要发 Socket 消息。

准备：

1. 确认环境 `COLLAB_V2=1`。
2. 用浏览器 A 新建或打开一张图。
3. 把同一链接在浏览器 B 打开。
4. 确认两人都看到「协同」按钮已连上（协同中）。

每一项记录：`PASS` / `FAIL`，以及 A、B、PostgreSQL 是否一致。

| # | 操作（几步） | A | B | PG | 结果 |
| --- | --- | --- | --- | --- | --- |
| 1 | Enter：A 点中节点，按 Enter，出现同级节点 |  |  |  |  |
| 2 | Tab：A 点中节点，按 Tab，出现子节点 |  |  |  |  |
| 3 | Delete：A 点中非根节点，按 Delete，节点消失 |  |  |  |  |
| 4 | Ctrl+C / V / X：A 复制或剪切后粘贴，B 看到新节点 |  |  |  |  |
| 5 | Ctrl+Z / Y：A 撤销再重做，B 跟随 |  |  |  |  |
| 6 | Ctrl+F：搜索框出现，可输入关键字跳转 |  |  |  |  |
| 7 | Search：搜索已有节点文字，能定位 |  |  |  |  |
| 8 | Replace：替换一处文字，B 与库中文字更新 |  |  |  |  |
| 9 | Drag：A 拖动节点改层级或顺序，B 布局跟随 |  |  |  |  |
| 10 | 工具栏新增：选中节点后点「同级节点 / 子节点」 |  |  |  |  |
| 11 | 备注：给节点加备注，B 能看到备注标记 |  |  |  |  |
| 12 | 标签：给节点加标签，B 能看到标签 |  |  |  |  |
| 13 | 超链接：给节点加链接，B 能看到链接图标 |  |  |  |  |
| 14 | 图片：给节点加图片，B 能看到图片 |  |  |  |  |
| 15 | 概要：给节点加概要，B 能看到概要 |  |  |  |  |
| 16 | 外框：给节点加外框，B 能看到外框 |  |  |  |  |
| 17 | 关联线：在两个节点间画关联线，B 能看到 |  |  |  |  |
| 18 | 主题：A 换主题，B 主题一致 |  |  |  |  |
| 19 | 布局：A 换结构/布局，B 布局一致 |  |  |  |  |
| 20 | mapRef：右键节点绑定另一张图，B 出现引用图标 |  |  |  |  |
| 21 | Import：A 导入一份思维导图，整图被替换，B 同步 |  |  |  |  |
| 22 | Viewer：只读成员不能 Enter / 删除 / 粘贴 |  |  |  |  |
| 23 | Offline：断开协作网络后继续编辑，刷新后未提交内容仍在 |  |  |  |  |
| 24 | Reconnect：恢复协作网络后未提交内容发出，A/B/库一致 |  |  |  |  |

## 记录说明

- Browser A：操作者界面是否立刻正确。
- Browser B：另一窗口是否在几秒内看到同样结果。
- PostgreSQL：刷新页面或重新打开同一链接后，内容是否仍在（即已落库）。
- 选中节点后点工具栏，如果选择先丢掉、按钮无反应：记 FAIL，并写「工具栏丢失选中」。
- 快捷键无反应：先确认鼠标还在画布/节点上，再记 FAIL。

## 本轮机器结果（测试人员可对照）

人工仍以自己的操作为准。机器只完成了 Level 1 准备和部分基础设施。

| 项 | 机器 |
| --- | --- |
| 页面打开 + 最新 bundle | Playwright PASS |
| V2 connecting → live（直连 Collaboration Server） | Playwright PASS |
| A/B 同一 room、双方 presence | Playwright PASS |
| A 点节点后 Enter，A 出现「二级节点」 | Playwright PASS |
| 同一操作写入 PostgreSQL | Playwright FAIL |
| B 看到新节点 | 未测到（卡在 PG） |
| 100 次 Socket connect/disconnect | Playwright PASS，进程未退出 |
| ACL `/api/auth/e2e-identity` → cookie → `/api/auth/me` → 打开编辑 | Playwright PASS |
| Offline / Gap / Clipboard / mapRef / Import | 本轮未作为通过标准 |

Enter 后 A 本地有节点、V2 `live`、双方已互见，但 `lastPushed` 没有新节点、IndexedDB 无 pending、PostgreSQL 仍是 5 个节点。请人工用两个浏览器按第 1 项复现：如果 B 和刷新后也没有新节点，这是产品问题，不是测试问题。
