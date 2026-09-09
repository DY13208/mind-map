const MAX_TITLE_LENGTH = 40
const MIN_TITLE_LENGTH = 2

function plainText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanCandidate(value) {
  let text = plainText(value)
    .replace(/^[“”‘’"'《》【】\s]+|[“”‘’"'《》【】\s]+$/g, '')
    .replace(/[（(]\s*(?:负责人|接收人|待办人|代办人|执行人)(?:\s*[:：][^）)]*)?\s*[）)]\s*$/i, '')
    .replace(/^(?:，|,|。|；|;|：|:|\s)+/, '')
    .trim()

  // 口语里的后半句才是真正事项：提醒他测试一下 / 内容是核对报价。
  text = text
    .replace(/^(?:(?:然后|并且|再|顺便)?\s*)?(?:提醒|通知|告诉|让|叫|请)\s*(?:他|她|对方|负责人)?\s*/i, '')
    .replace(/^(?:待办)?(?:标题|内容|事项)\s*(?:是|为|叫|写|写成)?\s*[：:]?\s*/i, '')
    .split(/[，,；;。！？!?]/, 1)[0]
    .replace(/(?:一下|一下子|吧|啦|哦|哈)\s*$/i, '')
    .replace(/[（(]\s*(?:负责人|接收人|待办人|代办人|执行人)(?:\s*[:：][^）)]*)?\s*[）)]\s*$/i, '')
    .replace(/^[“”‘’"'《》【】\s]+|[“”‘’"'《》【】\s]+$/g, '')
    .trim()
  return text
}

/**
 * 将自然语言派发指令转换为企业微信中可读的短标题。
 * 人员、渠道和流程说明属于描述，不应出现在待办标题里。
 */
export function normalizeWecomTodoTitle(value, fallback = '') {
  const raw = plainText(value)
  if (!raw) return fallback

  // 明确标题优先，避免把后续的派发说明一起带入。
  const labelled = raw.match(/(?:待办)?标题\s*[：:]\s*([^\n；;。！？!]+)/i)
  if (labelled && labelled[1]) {
    // 显式标题是用户确认过的业务文本，不再把其中的“创建/待办”等词当命令剥离。
    return (cleanCandidate(labelled[1]) || fallback).slice(0, MAX_TITLE_LENGTH)
  }

  // 拆分「接收人 + 创建动作 + 事项」，兼容自然口语的前置/后置事项。
  // 例：给胡炫创建一个测试待办 → 测试待办
  //     给胡炫创建待办，提醒他测试一下（负责人） → 测试
  const directed = raw.match(
    /^(?:(?:请|麻烦|劳烦|辛苦|顺便)\s*)?(?:帮我\s*)?(?:给|向|为)\s*[\u4e00-\u9fffA-Za-z·•]{2,20}?\s*(?:创建|新建|建立|建|添加|安排|发起|派发|下发|布置|分配|发(?:送)?)(?:一?(?:个|条))?\s*(.*)$/i
  )
  if (directed) {
    const payload = plainText(directed[1])
    const todoWord = payload.match(/(?:企业微信|企微)?(?:代办|待办)/i)
    if (todoWord) {
      const index = todoWord.index
      const before = cleanCandidate(payload.slice(0, index)).replace(/的\s*$/, '')
      const after = cleanCandidate(payload.slice(index + todoWord[0].length))
      const subject = before || after
      if (subject && !/^(?:一个|一条|代办|待办)$/.test(subject)) {
        const title = before && !/(?:代办|待办)$/i.test(before)
          ? `${before}待办`
          : subject
        return title.slice(0, MAX_TITLE_LENGTH)
      }
      return fallback
    }
  }

  // 「提醒胡炫处理测试待办」→「测试待办」。
  const reminder = raw.match(
    /^(?:(?:请|麻烦|劳烦|辛苦|顺便)\s*)?(?:提醒|通知|催办|知会)\s*[\u4e00-\u9fffA-Za-z·•]{2,20}?\s*((?:去|来)?(?:处理|完成|跟进|执行|办理|确认).+)$/i
  )
  if (reminder) {
    const subject = cleanCandidate(reminder[1])
    if (subject && !/^(?:代办|待办)$/.test(subject)) {
      return subject.slice(0, MAX_TITLE_LENGTH)
    }
    return fallback
  }

  let title = raw
    .replace(/^AI\s*[:：]\s*/i, '')
    .replace(/^(?:请)?(?:处理|执行|跟进|完成|创建|新建|建立|建|添加)\s*[:：]\s*/i, '')
    .replace(/\s*(?:→|—|-)\s*(?:代办|待办)[：:].*$/, '')
    .replace(/\s*[|｜].*$/, '')
    .trim()

  title = cleanCandidate(title)

  // 解析失败的整句派发指令宁可回落为通用标题，也不泄漏成冗长标题。
  if (
    /^(?:(?:需要|想要|帮忙|麻烦|劳烦|辛苦|请)\s*)?(?:帮我\s*)?(?:给|向|为).*(?:创建|新建|建立|建|添加|安排|发起|派发|下发|布置|分配|发(?:送)?|弄|搞|整).*(?:代办|待办|任务|事情)/.test(
      title
    )
  ) {
    title = ''
  }
  if (/^(?:知会|通知|提醒)(?:类)?(?:代办|待办)?$/i.test(title)) title = ''

  return (title || fallback).slice(0, MAX_TITLE_LENGTH)
}

/**
 * 企业微信待办的统一边界：标题只能是执行事项，不能是派发指令。
 * 无法从指令中得出事项时拒绝创建，避免发送一条错误待办。
 */
export function prepareWecomTodoDraft({ title, description, assignee } = {}) {
  const normalizedTitle = normalizeWecomTodoTitle(title)
  if (normalizedTitle.length < MIN_TITLE_LENGTH) {
    return {
      ok: false,
      code: 'TODO_TITLE_REQUIRED',
      error: '无法识别待办标题。请使用“标题：核对报价单”或直接填写具体事项。'
    }
  }
  return {
    ok: true,
    title: normalizedTitle,
    description: String(description || '').trim().slice(0, 2000),
    assignee: String(assignee || '').trim()
  }
}
