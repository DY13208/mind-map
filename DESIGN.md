---
name: 依然中台
description: 面向企业长期协作的克制型脑图与文件工作台
colors:
  primary: "#087854"
  primary-hover: "#066646"
  primary-soft: "#e8f4ef"
  background: "#f7f9f8"
  surface: "#ffffff"
  surface-muted: "#f1f5f3"
  text: "#17261f"
  text-secondary: "#66756e"
  text-muted: "#7b8982"
  border: "#e7ece9"
  border-strong: "#cbd8d2"
  danger: "#b8433a"
typography:
  headline:
    fontFamily: "Inter, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.25
  title:
    fontFamily: "Inter, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "Inter, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "16px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "40px"
---

# Design System: 依然中台

## 1. Overview

**Creative North Star: “安静的企业工作台”**

界面以克制、清晰、可信为核心，在高信息密度下维持稳定的视觉节奏。设计服务于查找、创建、编辑、协作和管理，不与用户争夺注意力。

文件、文件夹、成员与权限使用同一套结构、状态和操作词汇。拒绝营销官网式 Hero、大 Banner、玻璃拟态、夸张动画和概念稿式装饰。

**Key Characteristics:**

- 宽屏充分利用，主内容最大宽度 1600px，数据管理页面可接近全宽。
- 绿色只用于主操作、选中态、Focus 和状态强调。
- 平面优先，以边框和轻微色阶建立层级。
- 桌面端高效，窄屏通过结构重排而非整体缩小适配。

## 2. Colors

低色度绿色中性体系，适合长时间阅读和高频操作。

### Primary
- **深松绿** (#087854)：页面唯一主操作、当前导航、Focus 与正向状态。
- **松绿浅底** (#E8F4EF)：选中态和低强度状态背景。

### Neutral
- **工作台底色** (#F7F9F8)：页面背景。
- **内容白** (#FFFFFF)：卡片、菜单和面板。
- **主墨色** (#17261F)：标题与正文。
- **次级墨色** (#66756E)：说明、元数据和辅助标签。
- **结构线** (#E7ECE9)：卡片、表格和分隔线。

**克制绿色规则。** 绿色面积应保持在单屏约 10% 以内；非活动元素不得使用高饱和绿色。

## 3. Typography

**Display Font:** Inter（PingFang SC / Microsoft YaHei 回退）  
**Body Font:** Inter（PingFang SC / Microsoft YaHei 回退）

**Character:** 单一无衬线字体承担产品界面全部层级，强调稳定、紧凑和快速扫描。

### Hierarchy
- **Headline** (600, 24–28px, 1.25)：页面标题。
- **Title** (600, 16–18px, 1.4)：区块与重要卡片标题。
- **Body** (400, 14px, 1.5)：正文与操作内容。
- **Label** (500, 12–13px, 1.4)：元数据和辅助信息，不使用 11px 以下文字。

**稳定比例规则。** 产品界面不使用流体大标题；信息层级依靠有限字号、字重和间距表达。

## 4. Elevation

默认无明显阴影，以背景色、1px 边框和间距分层。仅在卡片 Hover、Dropdown、Modal 与 Toast 等脱离文档流的状态中出现轻量阴影。

### Shadow Vocabulary
- **Hover** (`0 6px 18px rgba(23, 38, 31, 0.07)`)：可点击卡片悬停。
- **Modal** (`0 20px 60px rgba(23, 38, 31, 0.16)`)：模态层。

**静止平面规则。** 静止卡片保持平面；阴影是状态反馈，不是装饰。

## 5. Components

### Buttons
- **Shape:** 8px 圆角；主要点击区域高度不低于 36px。
- **Primary:** 深松绿底、白字；单个页面原则上最多一个。
- **Hover / Focus:** 深一阶绿色；2px 清晰 Focus ring。
- **Secondary / Ghost:** 白底边框或透明底，仅危险操作使用红色。

### Chips
- **Style:** 浅中性或浅绿色背景，12–13px 文本，不用饱和色填满。
- **State:** 选中与未选中同时通过颜色和边框变化表达。

### Cards / Containers
- **Corner Style:** 8–12px。
- **Background:** 白色。
- **Shadow Strategy:** 静止无阴影，Hover 使用轻阴影。
- **Border:** 1px #E7ECE9。
- **Internal Padding:** 16–20px。

### Inputs / Fields
- **Style:** 白底、1px 结构线、8px 圆角、正文 14px。
- **Focus:** 绿色边框与 2px Focus ring。
- **Error / Disabled:** 错误仅用红色；禁用降低对比但仍保持文字可读。

### Navigation
- 216px 桌面侧栏；当前项使用浅绿背景与深绿文字。窄屏收折为抽屉，菜单文字、图标和 40px 行高保持一致。

### Unified File Item
- 文件夹与脑图共享 Grid/List、尺寸、Hover、选择和更多操作位置；脑图优先展示真实缩略图，缺失时使用低干扰结构占位。

## 6. Do's and Don'ts

### Do:
- **Do** 使用 4/8/12/16/20/24/32 间距节奏和 1440–1600px 内容宽度。
- **Do** 使用 `repeat(auto-fill, minmax(240px, 1fr))` 构建宽屏自适应文件网格。
- **Do** 为交互组件提供 Hover、Active、Focus、Disabled、Loading 和 Error 状态。
- **Do** 以 WCAG 2.1 AA 为基线并支持 `prefers-reduced-motion`。

### Don't:
- **Don't** 使用营销官网式的大型 Hero、展示型 Banner 或低信息密度布局。
- **Don't** 使用大面积渐变、玻璃拟态、高饱和背景、过度圆角和阴影或夸张动画。
- **Don't** 把管理工具做成 Dribbble 概念稿，或让不同页面形成彼此割裂的视觉语言。
- **Don't** 给所有按钮着色；绿色只属于主操作、选中态与状态强调。
- **Don't** 用大于 1px 的彩色侧边条装饰卡片或提示。
