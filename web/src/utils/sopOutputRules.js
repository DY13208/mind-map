import { getTextFromHtml } from 'simple-mind-map/src/utils'

export const OUTPUT_RULES_NODE_TITLE = '输入规则'

function nodeData(node) {
  return (node && node.data) || node || {}
}

export function outputRuleNodeText(node) {
  const data = nodeData(node)
  return getTextFromHtml(data.text || '').trim()
}

export function normalizeOutputRuleText(value) {
  return getTextFromHtml(String(value || ''))
    .replace(/[，,]/g, ',')
    .replace(/[：:]/g, ':')
    .replace(/[；;]/g, ';')
    .replace(/[。.]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function uniqueOutputRules(rules) {
  const seen = new Set()
  const out = []
  ;(rules || []).forEach(value => {
    const text = getTextFromHtml(String(value || '')).replace(/\s+/g, ' ').trim()
    const key = normalizeOutputRuleText(text)
    if (!text || !key || seen.has(key)) return
    seen.add(key)
    out.push(text)
  })
  return out
}

// Legacy optimized artifacts stored only a readable chat transcript. Extract
// user turns so a failed map write can be repaired without saving assistant
// suggestions as output rules.
export function extractUserOutputRulesFromInstruction(instruction) {
  const lines = String(instruction || '').split(/\r?\n/)
  const rules = []
  let current = []
  let collecting = false
  const flush = () => {
    if (collecting && current.length) rules.push(current.join('\n').trim())
    current = []
  }
  lines.forEach(line => {
    if (/^用户[：:]/.test(line)) {
      flush()
      collecting = true
      current.push(line.replace(/^用户[：:]\s*/, ''))
      return
    }
    if (/^助理[：:]/.test(line)) {
      flush()
      collecting = false
      return
    }
    if (collecting) current.push(line)
  })
  flush()
  return uniqueOutputRules(rules)
}

export function findOutputRulesBranch(tree) {
  const root = (tree && tree.tree) || tree
  return (
    ((root && root.children) || []).find(
      child => outputRuleNodeText(child) === OUTPUT_RULES_NODE_TITLE
    ) || null
  )
}

export function extractOutputRulesFromTree(tree) {
  const branch = findOutputRulesBranch(tree)
  if (!branch) return []
  return uniqueOutputRules(
    (branch.children || []).map(child => outputRuleNodeText(child))
  )
}

export function formatOutputRulesPrompt(rules) {
  const list = uniqueOutputRules(rules)
  if (!list.length) return ''
  return [
    '## 脑图已保存的输出规则',
    ...list.map((rule, index) => `${index + 1}. ${rule}`),
    '',
    '这些规则只约束最终产物的内容、结构、样式和格式，不是业务字段，不得据此补造业务数据、改变 SOP 步骤或发送通知。',
    '与系统默认展示方式冲突时以这些规则为准；与本轮用户明确提出的新要求冲突时以本轮新要求为准。不得因此增加用户未选择的产物类型或额外文件。'
  ].join('\n')
}
