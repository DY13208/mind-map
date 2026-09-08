/**
 * sopNotify 识别 / 阻塞判断冒烟
 */
function stripNodeText(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/^[-*•●]\s*/, '')
    .trim()
}

const NOTIFY_TITLE_RE =
  /AI\s*发起\s*通知|发起通知|^通知\s*[：:]|知会|请通知|发送通知|^AI\s*[:：].*通知|抄送/i
const BLOCK_TITLE_RE = /等待|确认|审批|阻塞|签核|复核通过/i
const CONTINUE_HINT_RE = /知会|抄送|仅通知|不阻塞|无需等待/i

function isNotifyTitle(text) {
  return NOTIFY_TITLE_RE.test(stripNodeText(text))
}

function shouldBlockNotify(text, contextText = '') {
  const blob = `${stripNodeText(text)}\n${stripNodeText(contextText)}`
  if (CONTINUE_HINT_RE.test(blob) && !/必须等待|务必确认|强制阻塞/.test(blob)) {
    return false
  }
  return BLOCK_TITLE_RE.test(blob)
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

assert(isNotifyTitle('AI发起通知：排产确认'), 'AI发起通知')
assert(isNotifyTitle('知会：本周目标'), '知会')
assert(isNotifyTitle('AI: 通知对应的HRBP'), 'AI: 通知')
assert(!isNotifyTitle('D1：销售目标'), '普通 SOP 不是通知')

assert(shouldBlockNotify('AI发起通知：请确认排产'), '确认→阻塞')
assert(shouldBlockNotify('发起通知：等待审批'), '等待→阻塞')
assert(!shouldBlockNotify('知会：本周进度'), '知会→不阻塞')
assert(!shouldBlockNotify('AI发起通知：仅通知结果'), '仅通知→不阻塞')

console.log('sopNotify smoke OK')
