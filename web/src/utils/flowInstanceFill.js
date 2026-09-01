import { streamChat } from './workbuddyChat'
import { plainText } from './flowSearch'
import { parseMindmapChildren } from './mindmapChildrenParse'

const DATA_COLLECTION_TITLES = /^(提供|模块|填写|补充数据)$/

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function fieldLabel(text) {
  return stripHtml(text).split(/[：:]/)[0].trim()
}

function hasFilledValue(text) {
  const s = stripHtml(text)
  const idx = Math.max(s.indexOf('：'), s.indexOf(':'))
  if (idx < 0) return false
  return s.slice(idx + 1).trim().length > 0
}

function isDataCollectionNode(text) {
  return DATA_COLLECTION_TITLES.test(stripHtml(text))
}

/** 从需求节点文案提取已知事实 */
export function extractRequestFacts(query, targetNode) {
  const q = String(query || '').trim()
  const facts = { raw: q }

  const m1 = q.match(/招聘(?:一个|一名|一位)?\s*([A-Za-z0-9\u4e00-\u9fa5]{2,})/i)
  if (m1) facts.position = m1[1]

  const m2 = q.match(/\b(ITBP|HRBP|BP)\b/i)
  if (m2 && !facts.position) facts.position = m2[1]

  if (/招聘/.test(q) && facts.position) {
    facts.intent = '招聘'
  }

  let cur = targetNode && targetNode.parent
  const path = []
  while (cur && path.length < 6) {
    path.unshift(plainText(cur))
    cur = cur.parent
  }
  facts.ancestorPath = path.filter(Boolean)

  return facts
}

/** 数据项是否尚未填写具体值 */
export function needsDataFill(trees) {
  let unfilled = 0
  let dataFields = 0

  const walk = (list, inDataZone) => {
    ;(list || []).forEach(item => {
      if (!item || !item.data) return
      const text = item.data.text || ''
      const label = fieldLabel(text)
      const kids = item.children || []
      const nowInData =
        inDataZone || isDataCollectionNode(text) || /提供|模块/.test(label)

      if (nowInData && kids.length === 0 && label.length >= 2) {
        if (!/^(概要|部门负责人|提供|模块)$/.test(label)) {
          dataFields++
          if (!hasFilledValue(text)) unfilled++
        }
      }

      if (kids.length) walk(kids, nowInData)
    })
  }

  walk(trees, false)
  return dataFields > 0 && unfilled > 0
}

/** 本地规则先填一批确定值 */
export function applyLocalFacts(trees, facts) {
  const defaults = [
    {
      keys: ['招聘岗位', '岗位名称', '岗位'],
      build: () => (facts.position ? `招聘岗位：${facts.position}` : null)
    },
    {
      keys: ['工作性质'],
      build: () => '工作性质：全职'
    },
    {
      keys: ['招聘城市'],
      build: () => '招聘城市：深圳'
    },
    {
      keys: ['招聘人数'],
      build: () => '招聘人数：1'
    },
    {
      keys: ['性别要求'],
      build: () => '性别要求：不限'
    },
    {
      keys: ['招聘原因'],
      build: () => '招聘原因：新增岗位'
    },
    {
      keys: ['公司主体'],
      build: () => '公司主体：待确认'
    },
    {
      keys: ['招聘部门'],
      build: () => {
        const dept = (facts.ancestorPath || []).find(t =>
          /人事|技术|财务|项目|IT|HR/i.test(t)
        )
        return dept ? `招聘部门：${dept}` : '招聘部门：待确认'
      }
    },
    {
      keys: ['职级'],
      build: () => {
        if (/高级|资深|senior/i.test(facts.raw)) return '职级：高级'
        if (/初级|junior/i.test(facts.raw)) return '职级：初级'
        if (/ITBP|HRBP/i.test(facts.position || facts.raw)) return '职级：中级'
        return '职级：待确认'
      }
    }
  ]

  const walk = list => {
    ;(list || []).forEach(item => {
      if (!item || !item.data) return
      const label = fieldLabel(item.data.text)
      if (!hasFilledValue(item.data.text)) {
        for (const rule of defaults) {
          if (rule.keys.some(k => label === k || label.startsWith(k))) {
            const val = rule.build()
            if (val) {
              item.data.text = val
              break
            }
          }
        }
      }
      walk(item.children)
    })
  }

  walk(trees)
  return trees
}

export function buildFillDataPrompt({ query, trees, facts, templateLabel }) {
  const system = `你是良策思维导图数据填写助手。

用户已有一份从 SOP 克隆的固定子节点树。你的任务 ONLY 是为「模块/提供」下的数据项填写具体值。

硬性要求：
1. 必须保持 children 层级、节点数量、顺序与输入完全一致
2. 只修改数据项节点的 text，格式为「字段名：具体值」，如「招聘岗位：ITBP」
3. 执行步骤、概要、部门负责人提交招聘需求等流程节点文案保持与输入一致
4. 能从需求推断的必须填写；无法确定的写「待确认」或合理默认值，不能留空标签
5. 必须调用 add_mindmap_children 返回填好值后的完整 children`

  const user = [
    `需求节点：${query}`,
    `SOP 模板：${templateLabel || '招聘'}`,
    `已知信息：${JSON.stringify(facts, null, 2)}`,
    '',
    '请为以下结构中的数据项填写具体值（结构不变）：',
    JSON.stringify(trees, null, 2).slice(0, 55000),
    '',
    '调用 add_mindmap_children 返回 children。'
  ].join('\n')

  return { system, user }
}

const ADD_CHILDREN_TOOL = {
  type: 'function',
  function: {
    name: 'add_mindmap_children',
    description: '返回填好具体值后的子节点树，结构必须与输入一致。',
    parameters: {
      type: 'object',
      properties: {
        children: {
          type: 'array',
          description: '子节点列表，每项 {text, note?, children?}',
          items: { type: 'object' }
        }
      },
      required: ['children']
    }
  }
}

/** 调用 WorkBuddy 为已克隆结构填写数据值；失败时回退本地规则 */
export async function fillInstanceData({
  trees,
  query,
  targetNode,
  templateLabel,
  signal,
  onEvent,
  skipRemote = false
}) {
  const facts = extractRequestFacts(query, targetNode)
  let working = applyLocalFacts(JSON.parse(JSON.stringify(trees)), facts)

  if (!needsDataFill(working) || skipRemote) {
    return working
  }

  const { system, user } = buildFillDataPrompt({
    query,
    trees: working,
    facts,
    templateLabel
  })

  try {
    const result = await streamChat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      extra: {
        tools: [ADD_CHILDREN_TOOL],
        tool_choice: {
          type: 'function',
          function: { name: 'add_mindmap_children' }
        }
      },
      signal,
      onEvent
    })

    const filled = parseMindmapChildren(result)
    if (filled.length) {
      working = applyLocalFacts(filled, facts)
    }
  } catch (err) {
    console.warn('[fillInstanceData] WorkBuddy 填写失败，使用本地规则', err)
  }

  return working
}
