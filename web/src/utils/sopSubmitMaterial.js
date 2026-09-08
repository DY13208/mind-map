/**
 * SOP「提交资料 / 提供 / 模块」类节点：
 * 运行前抽出字段模板，先填写再入队执行。
 */

export const SUBMIT_ZONE_RE =
  /^(?:提交资料|提交需求|提供资料|提供|模块|填写|补充数据|需求信息|申请信息|资料提交|需求方提交|申请人填写)(?:\s*[（(].*[）)]*)?$/i

export const SUBMIT_ZONE_LOOSE_RE =
  /提交资料|提交需求|提供资料|资料提交|补充数据|填写资料|需求信息|提交招聘需求/

const SKIP_LABEL_RE =
  /^(?:概要|部门负责人|提供|模块|填写|补充数据|提交资料|提交需求|代办人|待办人|负责人|AI|通知|步骤|流程|C|P|检查|计划|目标)$/i

const MAX_LABEL_LEN = 36

function stripText(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/^[-*•●\d.、）)\s]+/, '')
    .trim()
}

export function isSubmitMaterialZone(text) {
  const t = stripText(text)
  if (!t) return false
  if (SUBMIT_ZONE_RE.test(t)) return true
  // 需求方:提交招聘需求 / 提交xxx需求
  if (/^需求方\s*[:：]\s*提交/.test(t)) return true
  if (/提交[^：:\n]{0,16}需求/.test(t)) return true
  return SUBMIT_ZONE_LOOSE_RE.test(t) && t.length <= 36
}

function fieldLabelOf(text) {
  const s = stripText(text)
  const idx = Math.max(s.indexOf('：'), s.indexOf(':'))
  const left = (idx >= 0 ? s.slice(0, idx) : s)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[（(][^）)]*$/, '')
    .trim()
  return left
}

function fieldHintOf(text) {
  const s = stripText(text)
  const idx = Math.max(s.indexOf('：'), s.indexOf(':'))
  if (idx < 0) {
    const tip = s.match(/[（(]([^）)]+)[）)]/)
    return tip ? tip[1].trim() : ''
  }
  return s.slice(idx + 1).trim()
}

function hasFilledValue(text) {
  let hint = fieldHintOf(text)
  if (!hint) return false
  hint = hint.replace(/^[（(]|[）)]$/g, '').trim()
  if (/^(?:示例|例如|如|待填|待补充|空|xx|XXX|…|\.{2,})/i.test(hint)) {
    return false
  }
  if (/^请|^填|^输入/.test(hint)) return false
  return hint.length > 0
}

function isOptionLike(text) {
  const t = stripText(text)
  if (!t || t.length > 24) return false
  if (/^默认\s*[:：]/.test(t)) return true
  // 枚举项：初级/新增/实习生 —— 短且无叙述句
  if (/[。；!！？?]/.test(t)) return false
  if (/^(?:AI|HRBP|人:|需求方:)/.test(t)) return false
  return t.length <= 16 && !isSubmitMaterialZone(t)
}

function parseDefaultValue(text) {
  const t = stripText(text)
  const m = t.match(/^默认\s*[:：]\s*(.+)$/)
  return m ? m[1].trim() : ''
}

/** 招聘类保底（仅大纲完全抽不到字段时） */
export const RECRUIT_SUBMIT_FIELDS = [
  { key: 'f_company', label: '公司主体', hint: '如：XX有限公司', value: '' },
  { key: 'f_job', label: '招聘岗位', hint: '岗位名称', value: '' },
  { key: 'f_dept', label: '招聘部门', hint: '如：客服中心', value: '' },
  { key: 'f_gender', label: '性别要求', hint: '默认：不限', value: '不限' },
  { key: 'f_level', label: '职级', hint: '初级 / 中级 / 高级', value: '' },
  { key: 'f_nature', label: '工作性质', hint: '默认：全职', value: '全职' },
  { key: 'f_count', label: '招聘人数', hint: '默认：1', value: '1' },
  { key: 'f_city', label: '招聘城市', hint: '默认：深圳', value: '深圳' },
  { key: 'f_reason', label: '招聘原因', hint: '离职替补 / 新增', value: '' },
  { key: 'f_mentor', label: '试用期带教导师', hint: '导师姓名', value: '' },
  {
    key: 'f_plan',
    label: '新人试用期成长计划表',
    hint: '是否需要 / 是否用 AI 预起草',
    value: ''
  },
  { key: 'f_hard', label: '硬性要求', hint: '学历、经验等硬性条件', value: '' }
]

/**
 * 从大纲文本抽取「提交资料」区字段模板
 */
export function extractSubmitMaterialFields(outline, { sopTitle = '' } = {}) {
  const lines = String(outline || '').split(/\r?\n/)
  const fields = []
  const seen = new Set()
  const zones = []

  const push = (label, hint = '', value = '') => {
    const name = String(label || '')
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/[（(][^）)]*$/, '')
      .replace(/\s+/g, '')
      .trim()
    if (!name || name.length > MAX_LABEL_LEN) return
    if (SKIP_LABEL_RE.test(name)) return
    if (/[。；!！？?\n]/.test(name)) return
    if (isSubmitMaterialZone(name)) return
    const key = name.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    fields.push({
      key: `sm_${fields.length + 1}`,
      label: name,
      hint: String(hint || '').slice(0, 80),
      value: value || ''
    })
  }

  const rows = lines.map(line => {
    const indent = (line.match(/^(\s*)/) || ['', ''])[1].length
    const text = stripText(line.replace(/^(\s*)/, '').replace(/^[-*•●]\s*/, ''))
    return { indent, text, raw: line }
  })

  for (let i = 0; i < rows.length; i++) {
    const { indent, text } = rows[i]
    if (!text || !isSubmitMaterialZone(text)) continue
    zones.push(text)

    // 只取该区下「直接字段层」（indent > zone，且跳过选项子层）
    let j = i + 1
    while (j < rows.length) {
      const child = rows[j]
      if (!child.text) {
        j += 1
        continue
      }
      if (child.indent <= indent) break
      if (isSubmitMaterialZone(child.text)) {
        j += 1
        continue
      }

      // 收集该 child 的选项子节点
      const optionTexts = []
      let k = j + 1
      while (k < rows.length) {
        const opt = rows[k]
        if (!opt.text) {
          k += 1
          continue
        }
        if (opt.indent <= child.indent) break
        if (opt.indent > child.indent + 4) {
          // 更深嵌套：仍算在该字段下
          if (isOptionLike(opt.text) || /^默认\s*[:：]/.test(opt.text)) {
            optionTexts.push(opt.text)
          }
          k += 1
          continue
        }
        if (isOptionLike(opt.text) || /^默认\s*[:：]/.test(stripText(opt.text))) {
          optionTexts.push(opt.text)
          k += 1
          continue
        }
        // 非选项的更深节点：打断，当作新字段
        break
      }

      const label = fieldLabelOf(child.text)
      if (optionTexts.length) {
        let prefill = ''
        const hints = []
        optionTexts.forEach(ot => {
          const d = parseDefaultValue(ot)
          if (d && !prefill) prefill = d
          else hints.push(stripText(ot).replace(/^默认\s*[:：]\s*/, ''))
        })
        push(
          label,
          hints.filter(Boolean).join(' / ') || `请选择或填写${label}`,
          prefill
        )
        j = k
        continue
      }

      // 叶子字段
      const hasDeeper =
        rows[j + 1] &&
        rows[j + 1].text &&
        rows[j + 1].indent > child.indent
      if (hasDeeper) {
        // 有非选项子树，跳过本节点当分组
        j += 1
        continue
      }
      const hint = fieldHintOf(child.text)
      const prefill = hasFilledValue(child.text) ? hint : ''
      push(
        label,
        prefill ? '' : hint || (label ? `请填写${label}` : ''),
        prefill
      )
      j += 1
    }
  }

  if (!fields.length) {
    rows.forEach(({ text }) => {
      if (!text) return
      if (
        /^[^\s：:]{2,36}[：:]\s*$/.test(text) ||
        /^[^\s：:]{2,36}[：:]\s*(?:待填|待补充)?$/.test(text)
      ) {
        push(fieldLabelOf(text), `请填写${fieldLabelOf(text)}`, '')
      }
    })
  }

  const title = stripText(sopTitle)
  if (!fields.length && zones.length) {
    return {
      zones,
      fields: [
        {
          key: 'sm_free',
          label: '关键资料',
          hint: '请按大纲「提交资料」要求填写（可写多行）',
          value: ''
        }
      ],
      source: 'outline_zone_empty'
    }
  }

  if (!fields.length) {
    if (/招聘|HC|JD/i.test(title) || /提交资料|提交需求|提供资料/.test(title)) {
      RECRUIT_SUBMIT_FIELDS.forEach(f => {
        push(f.label, f.hint, f.value)
      })
      return {
        zones: ['提交资料（招聘保底模板）'],
        fields: fields.slice(0, 16),
        source: 'recruit_fallback'
      }
    }
  }

  return {
    zones,
    fields: fields.slice(0, 16),
    source: fields.length
      ? zones.length
        ? 'outline_zone'
        : 'outline_kv'
      : 'none'
  }
}

export function needsSubmitMaterialBeforeRun(outline, sopTitle) {
  const r = extractSubmitMaterialFields(outline, { sopTitle })
  return r.fields.length > 0
}

export function formatSubmitMaterialNote(fields, extra = '') {
  const lines = (fields || [])
    .map(f => {
      const v = String(f.value || '').trim()
      if (!v) return ''
      return `${f.label}：${v}`
    })
    .filter(Boolean)
  const other = String(extra || '').trim()
  if (!lines.length && !other) return ''
  return ['## 用户提交资料', ...lines, other ? `其它说明：${other}` : '']
    .filter(Boolean)
    .join('\n')
}

export function missingSubmitMaterialLabels(fields) {
  return (fields || [])
    .filter(f => !String(f.value || '').trim())
    .map(f => f.label)
}

export function parseProvidedFieldLabels(extraNote) {
  const text = String(extraNote || '')
  const labels = []
  const seen = new Set()
  text.split(/\r?\n/).forEach(line => {
    const t = line.trim()
    if (!t || /^#/.test(t) || /^其它说明/.test(t)) return
    const m = t.match(/^(.{1,36})[：:=]\s*(.+)$/)
    if (!m) return
    const label = m[1].trim()
    const val = m[2].trim()
    if (!val) return
    const key = label.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    labels.push(label)
  })
  return labels
}

export function isFieldAlreadyProvided(label, providedLabels) {
  const a = String(label || '')
    .replace(/\s+/g, '')
    .toLowerCase()
  if (!a) return false
  return (providedLabels || []).some(p => {
    const b = String(p || '')
      .replace(/\s+/g, '')
      .toLowerCase()
    if (!b) return false
    return a === b || a.includes(b) || b.includes(a)
  })
}
