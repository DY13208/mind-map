/**
 * 「运行」用哪条通道执行 —— 在右侧栏「设置 → AI 执行引擎」里选一次，
 * 之后点运行直接按它跑，**不再弹窗**（2026-10-08 用户要求）。
 *
 * 两条通道：
 *   openclaw  助理（OpenClaw）—— 流式直连，正文与产物按「本次运行的专属目录」写回
 *   bridge    桥接（执行机上的 WorkBuddy 会话）—— 派发 → 轮询回执 → 写回
 *
 * 这里只做「取值 / 落盘 / 归一化」，工具栏与设置面板共用，
 * 免得两边各写一套 localStorage key 而对不上。
 */
export const RUN_CHANNEL_OPENCLAW = 'openclaw'
export const RUN_CHANNEL_BRIDGE = 'bridge'
/** 没存过时的默认通道：助理（OpenClaw） */
export const RUN_CHANNEL_DEFAULT = RUN_CHANNEL_OPENCLAW

/** 设置里下拉框的选项（顺带当 label 表用） */
export const RUN_CHANNEL_OPTIONS = [
  {
    value: RUN_CHANNEL_OPENCLAW,
    label: '助理（OpenClaw）',
    desc: '流式直连，正文和产物都按本次运行的目录写回导图'
  },
  {
    value: RUN_CHANNEL_BRIDGE,
    label: '桥接（执行机的 WorkBuddy）',
    desc: '派发到执行机上的一条 WorkBuddy 会话，跑完再取回结果'
  }
]

const STORE_KEY = 'mindmap:runChannel'

/** 只认这两条，其它（老值 / 手改 / 空）一律回落默认 */
export function normalizeRunChannel(value) {
  const raw = String(value == null ? '' : value).trim()
  if (raw === RUN_CHANNEL_OPENCLAW || raw === RUN_CHANNEL_BRIDGE) return raw
  return RUN_CHANNEL_DEFAULT
}

export function readRunChannel() {
  try {
    if (typeof localStorage === 'undefined') return RUN_CHANNEL_DEFAULT
    return normalizeRunChannel(localStorage.getItem(STORE_KEY))
  } catch (err) {
    // 隐私模式读不到：用默认
    return RUN_CHANNEL_DEFAULT
  }
}

export function writeRunChannel(channel) {
  const value = normalizeRunChannel(channel)
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORE_KEY, value)
    }
  } catch (err) {
    /* 存不下不影响这次运行 */
  }
  return value
}

export function runChannelLabel(channel) {
  const hit = RUN_CHANNEL_OPTIONS.find(
    item => item.value === normalizeRunChannel(channel)
  )
  return (hit && hit.label) || RUN_CHANNEL_OPTIONS[0].label
}
