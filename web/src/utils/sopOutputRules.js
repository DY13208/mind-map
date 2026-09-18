/**
 * SOP 输出规则（内置，全员共用）
 *
 * 设计原则：
 * 1. 通用规则每次运行都生效（本节点出方案 + 改脑图建议 + 业务可读）。
 * 2. 分类规则仅当「规则表里存在该类别」且「本次勾选了对应产物」时生效。
 * 3. 人可读权威副本：/templates/sop-output-rules.xmind（与本文件保持同步）。
 */

export const SOP_OUTPUT_RULES_META = {
  id: 'sop-output-rules',
  title: 'SOP 输出规则',
  version: '2026-09-18d',
  templateXmindUrl: '/templates/sop-output-rules.xmind',
  templateJsonUrl: '/templates/sop-output-rules.json'
}

/** 每次 SOP 运行都必须遵守（与是否勾选产物无关） */
export const COMMON_RUN_RULES = {
  id: 'common',
  title: '执行与诊断分离',
  rules: `【读者】业务同事可读：中文短句；禁止 uid、runtime_tree、CSS/技术合规表。

【两段式·硬性】「执行」和「诊断」分开写。

── A. 执行本 SOP（只跑本节点子树步骤，逐步推进）──
1. 按本 SOP 子树步骤依次执行，能自动做的步骤都要做完；不能跳步后假装整单完成。
2. 无企微待办/人工确认步骤时：必须一次跑完全部可自动步骤并落盘；禁止半途停下等用户「续跑」。
   「跟踪进度」缺实际数时：只对「累计实际 / 完成率」等缺数字段标待接入，不得跳过制定/推导/分配，也不得只因跟踪缺数口头报「部分完成」。
3. 本 SOP 步骤标题里写明的输入（如「根据历史GMV数据…制定目标」）是本步骤必做，不是可忽略的「上游」。
   - 必须尽量从本脑图/本 SOP 可达数据里取历史与趋势，算出分渠道目标数字并写进产物。
   - 只有本 SOP 子树与可达数据里确实没有该输入时，才对「该字段」标「待接入」；对应步骤状态必须是未完成/阻塞，不能把整单写成「完成」。
4. 「不必考虑上游」仅指：不要因为别的 D 节点/外部系统没跑完就停手；不要把整页写成「等上游」。绝不等于可以不做本步骤要求的历史推算。
5. 禁止交付「只有结构、全是待接入、没有目标数字」的空壳，还声称已完成「制定目标」。
6. HTML：多图少字；图要展示目标结果（分渠道 GMV/实收目标、对比历史），禁止用「店铺数/分层数」冒充目标方案图。
6b. 【制定目标类 SOP·版式硬性】主视觉必须是「目标制定看板」（目标金额柱图 / 历史vs目标 / B2B 实收推导 / 敏感度或分配明细）。
   禁止把整页做成「GMV 达成进度执行单」壳（大面积「进度状态」列、每行红 pill「待接入」）。
   品牌映射失败或缺实际数：只在缺的那一两格写「待接入」并脚注原因；已有目标金额的行不得整行标「待接入」。
   有日销/历史实际等替代口径时，必须先算出完成率，禁止借口映射失败把进度列整列置待接入。
6c. 【制定全渠道GMV目标·数据路径硬性】
   - 主数据源必须是企微智能表格「2026销售日报表」（个护部日销表 / KPI财务数据等可达子表），按「历史实际年化 × 渠道定位系数」制定目标，并产出：敏感度三档、B2B 五部门实收推导、10–12 月补量分配。
   - 《UNOVE BY26 全渠道目标&排产》等排产/经营管理表若可读：只作交叉校验，禁止整表 dump 当最终 HTML（禁止只贴表内原值如「全渠道 173700000」交差）。
   - 若 BY26 可读而销售日报暂缺：仍须按脑图定位系数重算并给出三档敏感度；不得以「表已有目标」跳过推算。
   - 页签至少含：目标排名（或分渠道目标）、目标敏感度、部门实收；补量表可作独立区。

── B. 执行完成后再做脑图诊断（这时才看全图）──
7. 独立章节「## 脑图诊断（全图）」：顺畅度 / 需补充 / 需纠错；必须改·建议改·可提升。
8. 诊断不要当成执行失败主因；执行段按步骤真实完成度说话。

【汇报结构】
1. ## 一句话结论 — 本 SOP 各步骤做到哪；目标数字出了没有（禁止空壳却写「完成」）
2. ## 本次交付
3. ## 关键发现（本 SOP 子树）
4. ## 脑图诊断（全图）
5. ## 产物清单

【禁止】跳过未做步骤标完成；禁止空壳 HTML 冒充制定目标；禁止技术合规表。`
}

/**
 * 按产物类别的输出规则。
 * 只在本对象中「存在」的类别才会被注入；删掉某 key = 该类不再强制遵守。
 */
export const OUTPUT_CATEGORY_RULES = {
  html: {
    id: 'html',
    title: 'HTML',
    matchPresetIds: ['html'],
    rules: `（以下条款只约束生成的 HTML 文件，不要写进给业务看的文字汇报。）

交付硬性：
1. 本轮只输出一个新建的 .html（文件名含当前时间戳），双击可开；CSS/JS 全部内联；禁止外链 CDN、字体库、图标库、占位图/假链接。
2. 禁止覆盖/改写历史产物；续跑或重跑都另存新文件，旧 HTML 全部保留。
3. 业务数据集中在 window.DASHBOARD_DATA = {...}；禁止数字散落写死在 DOM/图表配置。
4. 适配桌面与移动端。

【内容策略·硬性：多图表、少文字，且必须对上 SOP 意图】
1. 先读本 SOP 步骤标题意图再画图。若步骤是「根据历史…制定…目标」，页面主图必须是「目标结果」（分渠道/分层 GMV 或实收目标柱图、历史 vs 目标对比），禁止只用「渠道数/店铺数」结构图交差。
2. 明细表金额列必须尽量填入推算出的目标数；仅当本 SOP 可达数据里确实没有历史基数时，该格才写「待接入」，并在判断卡写清缺哪一项输入。
3. 禁止交付「目标制定台账（骨架）」式空壳还声称已完成制定目标。
3b. 禁止「目标金额已填、但进度状态列整列红待接入」的达成进度壳。跟踪缺数时删掉「进度状态」列，或只在「实际/完成率」单元格写待接入；优先展示目标推导、敏感度、缺口/补量。
4. 首屏以图为主；说明文字每块 ≤1～2 句；判断卡结论 ≤20 字。
5. 本页主题＝本 SOP 步骤的产出物，不是「等上游」说明文。
6. 禁止模仿历史产物「GMV目标达成进度执行单」的版式；制定目标 SOP 以目标金额看板为准。

视觉 Design Tokens：
- 画布 #f5f6f8；卡片 #fff；边框 1px #e4e8ee；圆角 18px；阴影 0 12px 34px rgba(22,35,58,.07)
- 主文字 #18212f；次要 #6e7888；深色底 #18212f；主色蓝 #3968e8；浅蓝底 #eaf0ff
- 语义：红 #d85b62（预警/选中）、绿 #348864、琥珀 #b98222
- 字体："PingFang SC","Microsoft YaHei",Arial,sans-serif
- 容器 max-width 1460px，padding 28px 34px 52px
- 数字 tabular-nums；大数字 26px / weight 850 / letter-spacing -.06em；金额统一单位小数位并右对齐

页面结构（顺序固定）：
1) 顶栏：46px 深底圆角 Logo + eyebrow + 主标题；右侧 12px 灰元信息（周期/负责人即可）
2) 工具栏：页签 + 筛选/蓝色操作链接
3) 指标卡 5 列：优先放方案结构量（渠道数/分层数/待填金额项等）；预警用红
4) 主图区 1.15fr/.85fr：左图（12 月或分层对比柱图，柱圆角 7 7 2 2；常规 #6d8ff0，选中 #d85b62）+ 短脚注；右 2～4 条短判断卡
5) 排名条：统一蓝条；副标题写清「横条长度代表什么」（可用店铺数/步骤数等结构量）
6) 明细表：精简列，可横滚；不要用表格堆长文
7) 口径提醒条：≤3 行，左 3px 琥珀竖线
8) 页脚一行：本 SOP 来源与口径（不要展开上游依赖叙事）

交互：页签切换不重载；筛选同步高亮与脚注；图表重绘前销毁旧实例；单模块出错不白屏。
响应式：≤1050 指标 3 列、主图单列；≤650 指标 2 列、元信息隐藏、工具栏纵向。
禁止：position:absolute 布局（尤其卡内）；外部字体/图标/图链；本轮拆成多文件（须单文件内联）；覆盖历史产物；首屏大段文字墙。`
  },

  md: {
    id: 'md',
    title: 'Markdown',
    matchPresetIds: ['md'],
    rules: `1. 极短：一句话结论 → ≤5 条发现 → 本周动作 → 改脑图建议。
2. 用节点中文标题作依据，不贴 uid。
3. 若同时有 HTML，Markdown 只做目录级摘要，不重复页面长文。`
  },

  xlsx: {
    id: 'xlsx',
    title: 'Excel',
    matchPresetIds: ['xlsx'],
    rules: `1. 表头清晰、口径在表头或独立「口径」表说明；金额列统一小数位。
2. 分项合计可核对；不可相加的口径分表或加备注。
3. 给出可打开的绝对路径；文件名含 SOP 编号与标题关键词。`
  },

  json: {
    id: 'json',
    title: 'JSON',
    matchPresetIds: ['json'],
    rules: `1. 结构化对象至少含：结论、方案结构 KPI、动作、数据源、nodeSuggestions。
2. 缺失用 null 或 meta.missing，禁止 0 伪装；上游缺失不代表方案失败。`
  }
}

/**
 * 解析本次应遵守的规则：通用必有 + 已存在且被勾选的类别。
 * @param {Array<{id?: string}>|string[]} selectedOutputs
 */
export function resolveOutputRules(selectedOutputs = []) {
  const ids = new Set(
    (selectedOutputs || [])
      .map(o => (typeof o === 'string' ? o : o && o.id))
      .filter(Boolean)
      .map(String)
  )

  const categories = Object.values(OUTPUT_CATEGORY_RULES).filter(cat => {
    const matchIds = cat.matchPresetIds || [cat.id]
    return matchIds.some(id => ids.has(id))
  })

  return {
    meta: SOP_OUTPUT_RULES_META,
    common: COMMON_RUN_RULES,
    categories
  }
}

/** 拼进 user prompt 的规则正文 */
export function formatOutputRulesBlock(selectedOutputs = []) {
  const { meta, common, categories } = resolveOutputRules(selectedOutputs)
  const parts = [
    `## 输出规则脑图（内置 · ${meta.title} · v${meta.version}）`,
    '以下规则全员共用。未在规则表中出现的产物类别不做额外版式约束；已出现的类别必须严格遵守。',
    '',
    `### ${common.title}（每次运行必遵）`,
    common.rules
  ]

  if (categories.length) {
    parts.push('')
    parts.push('### 本次勾选且规则表已定义的类别')
    categories.forEach(cat => {
      parts.push('')
      parts.push(`#### ${cat.title}`)
      parts.push(cat.rules)
    })
  } else {
    parts.push('')
    parts.push(
      '### 本次未勾选规则表中的产物类别',
      '不强制 HTML/Markdown/Excel/JSON 版式；仍必须完成本 SOP 执行交付，并在文末单独给出「脑图诊断（全图）」。'
    )
  }

  parts.push(
    '',
    '### 汇报固定结构（执行与诊断剥离）',
    '## 一句话结论',
    '## 本次交付',
    '## 关键发现',
    '## 脑图诊断（全图）',
    '- 必须改：…',
    '- 建议改：…',
    '- 可提升：…',
    '## 产物清单',
    '- name: …',
    '  path: …',
    '（执行只看本 SOP；诊断才看全图；产物清单仅系统解析）'
  )

  return parts.join('\n')
}

export function listDefinedOutputCategories() {
  return Object.values(OUTPUT_CATEGORY_RULES).map(c => ({
    id: c.id,
    title: c.title,
    matchPresetIds: c.matchPresetIds || [c.id]
  }))
}
