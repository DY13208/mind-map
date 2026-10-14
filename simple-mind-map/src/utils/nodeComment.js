// 节点评论：数据规范化、按 id 合并（删除为墓碑）与评论标记外观

export function normalizeNodeComments(list) {
  // 只返回存活评论（过滤删除墓碑与非法数据），保证渲染不因脏数据崩溃
  return liveComments(list)
}

export function nodeCommentCount(data) {
  return normalizeNodeComments(data && data.comments).length
}

export function hasNodeCommentMarker(data) {
  return nodeCommentCount(data) > 0
}

// 评论标记配色：无底色，描边气泡 + 数字；未解决为蓝色，已解决为灰蓝；暗色模式用更亮的前景
export function commentMarkerViewState({ count = 0, resolved = false, dark = false, unread = false } = {}) {
  let color
  if (resolved) color = dark ? '#8c9198' : '#98a2b3'
  else color = dark ? '#69b1ff' : '#3370ff'
  const n = Math.max(0, Math.floor(Number(count) || 0))
  return {
    color,
    dotColor: '#f54a45',
    unread: !!unread && n > 0,
    label: n > 99 ? '99+' : String(n),
    title: resolved ? `${n} 条评论（已解决）` : unread ? `${n} 条评论（有未读）` : `${n} 条评论`
  }
}

// 标记几何：图标 + 数字，无内边距，紧跟在节点文字后面
export function commentMarkerGeometry(iconSize, label) {
  const size = Math.max(10, Number(iconSize) || 16)
  const fontSize = Math.max(10, Math.round(size * 0.82))
  const textWidth = Math.ceil(String(label || '').length * fontSize * 0.62)
  const gap = Math.max(2, Math.round(size * 0.18))
  const dotR = Math.max(2.5, Math.round(size * 0.18 * 2) / 2)
  return {
    width: size + gap + textWidth + 1,
    height: size,
    iconSize: size,
    fontSize,
    textX: size + gap,
    dot: { cx: size + gap + textWidth - dotR + 1, cy: dotR, r: dotR }
  }
}

// ---- 右上角融合评论标签（tab） ----

function parseColor(value) {
  const str = String(value || '').trim().toLowerCase()
  if (!str || str === 'none' || str === 'transparent') return null
  let m = str.match(/^#([0-9a-f]{3,8})$/)
  if (m) {
    let hex = m[1]
    if (hex.length === 3 || hex.length === 4) hex = hex.split('').map(c => c + c).join('')
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a }
  }
  m = str.match(/^rgba?\(([^)]+)\)$/)
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    if (parts.length >= 3 && parts.slice(0, 3).every(n => Number.isFinite(n))) {
      return { r: parts[0], g: parts[1], b: parts[2], a: Number.isFinite(parts[3]) ? parts[3] : 1 }
    }
  }
  if (str === 'white') return { r: 255, g: 255, b: 255, a: 1 }
  if (str === 'black') return { r: 0, g: 0, b: 0, a: 1 }
  return null
}

const toHex = c =>
  '#' + [c.r, c.g, c.b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')

function luminance(value) {
  const c = parseColor(value)
  if (!c) return 1
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255
}

// 颜色混合：t=0 返回 a，t=1 返回 b；无法解析时返回 fallback
export function mixColor(a, b, t, fallback = '#ffffff') {
  const ca = parseColor(a)
  const cb = parseColor(b)
  if (!ca || !cb) return fallback
  return toHex({ r: ca.r + (cb.r - ca.r) * t, g: ca.g + (cb.g - ca.g) * t, b: ca.b + (cb.b - ca.b) * t })
}

// 标签配色：底色基于节点填充色提亮并带一点主题蓝，保证在彩色节点上也清晰
export function commentTabColors({ fill, border, dark = false, resolved = false } = {}) {
  const base = parseColor(fill)
  const solidFill = base && base.a > 0.05 ? toHex(base) : dark ? '#262a30' : '#ffffff'
  const accent = resolved ? (dark ? '#8c9198' : '#98a2b3') : dark ? '#69b1ff' : '#3370ff'
  const tabFill = dark
    ? mixColor(mixColor(solidFill, '#000000', 0.2), accent, 0.2)
    : mixColor(mixColor(solidFill, '#ffffff', 0.55), accent, resolved ? 0.06 : 0.1)
  // 图标颜色按标签底色亮度选择，保证彩色节点 / 暗色模式下都清晰
  const lum = luminance(tabFill)
  const iconColor = resolved
    ? lum > 0.45 ? '#7d8796' : '#a6adb8'
    : lum > 0.45 ? '#3370ff' : '#8cc4ff'
  return {
    accent,
    iconColor,
    tabFill,
    border: parseColor(border) ? border : accent,
    innerLine: mixColor(tabFill, accent, 0.35),
    dot: '#f54a45',
    dotRing: tabFill
  }
}

const r1 = n => Math.round(n * 10) / 10

/**
 * 右上角标签几何（节点组坐标系）。
 * width/height 为节点总尺寸（含边框），节点轮廓位于 [hb, width-hb]。
 * merge=true：标签与节点边框融合——外轮廓从顶边弯起，经标签顶部绕到右边，
 *   内侧用一条 S 形曲线与节点内容分隔；标签可略高于节点顶部（lift），
 *   以免压到文字（contentTop 为内容顶部 y）。
 * merge=false：非矩形形状，退化为悬浮在右上角的圆角标签。
 */
export function commentTabGeometry({
  width,
  height,
  borderWidth = 0,
  borderRadius = 0,
  contentTop = 0,
  iconSize = 16,
  label = '1',
  merge = true
} = {}) {
  const hb = Math.max(0, Number(borderWidth) || 0) / 2
  const W = Math.max(0, Number(width) || 0)
  const H = Math.max(0, Number(height) || 0)
  const icon = Math.max(11, Math.min(16, Math.round((Number(iconSize) || 16) * 0.8)))
  const fontSize = Math.max(11, Math.round(icon * 0.86))
  const textW = Math.ceil(String(label).length * fontSize * 0.62)
  const padL = 7
  const padR = 8
  const gap = 3
  const tabH = icon + 8
  let tabW = padL + icon + gap + textW + padR
  const right = W - hb
  const top0 = hb
  // 节点太窄时不超过节点宽度的 70%
  tabW = Math.min(tabW, Math.max(icon + padL + padR, (W - 2 * hb) * 0.7))
  const left = right - tabW
  let lift
  let top
  let curve
  let rt
  let outerPath
  let fillPath
  let innerPath
  let yb
  if (merge) {
    const R = Math.max(0, Math.min(Number(borderRadius) || 0, (H - 2 * hb) / 2))
    // 标签底部不压到内容：内容上方留 1px
    lift = Math.max(0, Math.ceil(top0 + tabH - (Number(contentTop) || 0) + 1))
    lift = Math.min(lift, tabH - 6)
    top = top0 - lift
    curve = Math.min(10, Math.round(tabH * 0.45))
    rt = lift > 0 ? Math.max(3, Math.min(R || 4, tabH / 2)) : Math.min(R, tabH / 2)
    yb = Math.max(top + tabH, top0 + R + hb + 1)
    yb = Math.min(yb, H - hb - R)
    const sx = left - curve
    const outer =
      lift > 0
        ? `M${r1(sx)},${r1(top0)} C${r1(left - curve * 0.4)},${r1(top0)} ${r1(left - curve * 0.55)},${r1(top)} ${r1(left)},${r1(top)} `
        : `M${r1(sx)},${r1(top0)} `
    const corner = `L${r1(right - rt)},${r1(top)} Q${r1(right)},${r1(top)} ${r1(right)},${r1(top + rt)} L${r1(right)},${r1(yb)}`
    outerPath = outer + corner
    const inner = `M${r1(right)},${r1(yb)} L${r1(left + curve)},${r1(yb)} C${r1(left - curve * 0.15)},${r1(yb)} ${r1(left - curve * 0.35)},${r1(top0)} ${r1(sx)},${r1(top0)}`
    innerPath = inner
    fillPath = `${outerPath} L${r1(left + curve)},${r1(yb)} C${r1(left - curve * 0.15)},${r1(yb)} ${r1(left - curve * 0.35)},${r1(top0)} ${r1(sx)},${r1(top0)} Z`
  } else {
    lift = Math.round(tabH / 2)
    top = top0 - lift
    rt = tabH / 2
    curve = 0
    yb = top + tabH
    const l = left - 2
    const r = right - 2
    outerPath = `M${r1(l + rt)},${r1(top)} L${r1(r - rt)},${r1(top)} A${r1(rt)},${r1(rt)} 0 0 1 ${r1(r - rt)},${r1(yb)} L${r1(l + rt)},${r1(yb)} A${r1(rt)},${r1(rt)} 0 0 1 ${r1(l + rt)},${r1(top)} Z`
    fillPath = outerPath
    innerPath = ''
  }
  const shift = merge ? 0 : -2
  const midY = top + tabH / 2
  const iconX = left + padL + shift
  const dotR = 3.5
  return {
    merge,
    left: left + shift,
    right: right + shift,
    top,
    bottom: yb,
    tabW,
    tabH,
    lift,
    radius: rt,
    outerPath,
    fillPath,
    innerPath,
    icon: { x: r1(iconX), y: r1(midY - icon / 2), size: icon },
    text: { x: r1(iconX + icon + gap), y: r1(midY), size: fontSize },
    dot: { cx: r1(right + shift - Math.max(2, rt * 0.35)), cy: r1(top + Math.max(2, rt * 0.35)), r: dotR },
    hit: { x: r1(left - (merge ? curve * 0.5 : 0) + shift), y: r1(top), w: r1(tabW + (merge ? curve * 0.5 : 0)), h: r1(Math.max(tabH, yb - top)) }
  }
}

export function addNodeComment(list, comment) {
  return mergeComments(list, [comment])
}

// 删除用墓碑表示，保证与并发新增合并时不会「复活」
export function removeNodeComment(list, id, deletedBy = '', now = Date.now()) {
  return mergeComments(list, [{ id: String(id), deleted: true, deletedAt: now, deletedBy }])
}

// ---- 与 bin/commentMerge.js 同一算法（有对拍测试保证一致） ----
export const COMMENT_MAX_LENGTH = 2000
export const COMMENT_MAX_PER_NODE = 500
export const COMMENT_MAX_MENTIONS = 20
export const COMMENT_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const COMMENT_MAX_TOMBSTONES = 1000
export const COMMENT_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(CONTROL_RE, '').slice(0, max)
}

function hashString(text) {
  let h = 2166136261
  const s = String(text)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h.toString(36)
}

function normalizeMentions(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const name = cleanText(item.name, 64).trim()
    const userId = cleanText(item.userId != null ? item.userId : item.user_id, 160).trim()
    const key = userId || name
    if (!name || seen.has(key)) continue
    seen.add(key)
    out.push({ userId, name })
    if (out.length >= COMMENT_MAX_MENTIONS) break
  }
  return out
}

function safeAvatar(value) {
  const url = String(value || '').trim()
  if (url.length > 512) return ''
  return /^(https?:)?\/\//i.test(url) || /^data:image\/(png|jpe?g|gif|webp);/i.test(url) ? url : ''
}

// 单条评论规范化；无法识别的返回 null（不抛错，保证渲染/合并不崩）
export function normalizeComment(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  let id = String(item.id == null ? '' : item.id).trim()
  if (item.deleted === true) {
    if (!COMMENT_ID_RE.test(id)) return null
    const tomb = { id, deleted: true, deletedAt: Number(item.deletedAt) || 0 }
    if (item.deletedBy) tomb.deletedBy = cleanText(item.deletedBy, 160)
    return tomb
  }
  const content = cleanText(item.content, COMMENT_MAX_LENGTH).trim()
  if (!content) return null
  const time = Number(item.time) || 0
  if (!COMMENT_ID_RE.test(id)) id = `legacy_${time.toString(36)}_${hashString(content)}`
  const out = {
    id,
    userId: cleanText(item.userId, 160),
    userName: cleanText(item.userName, 64),
    avatar: safeAvatar(item.avatar),
    content,
    time
  }
  const mentions = normalizeMentions(item.mentions)
  if (mentions.length) out.mentions = mentions
  const replyTo = String(item.replyTo || '').trim()
  if (replyTo && COMMENT_ID_RE.test(replyTo)) out.replyTo = replyTo
  return out
}

function compareComments(a, b) {
  const ta = a.deleted ? a.deletedAt : a.time
  const tb = b.deleted ? b.deletedAt : b.time
  if (ta !== tb) return ta - tb
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * 合并两份评论数组（交换律、结合律、幂等）。
 * options.now / tombstoneTtlMs 控制过期墓碑压缩（0 表示不压缩）；
 * options.maxPerNode 限制存活评论数（保留最新）。
 */
export function mergeComments(base, incoming, options = {}) {
  const now = Number(options.now) || Date.now()
  const ttl = options.tombstoneTtlMs == null ? COMMENT_TOMBSTONE_TTL_MS : Number(options.tombstoneTtlMs)
  const maxPerNode = Number(options.maxPerNode) || COMMENT_MAX_PER_NODE
  const byId = new Map()
  const take = list => {
    if (!Array.isArray(list)) return
    for (const raw of list) {
      const item = normalizeComment(raw)
      if (!item) continue
      const prev = byId.get(item.id)
      if (!prev) {
        byId.set(item.id, item)
      } else if (item.deleted || prev.deleted) {
        let tomb
        if (item.deleted && prev.deleted) tomb = item.deletedAt >= prev.deletedAt ? item : prev
        else tomb = item.deleted ? item : prev
        byId.set(item.id, tomb)
      } else if (compareComments(item, prev) < 0) {
        // 同 id 的两条存活评论：取较早的那份，保证结果确定
        byId.set(item.id, item)
      }
    }
  }
  take(base)
  take(incoming)
  let live = []
  let tombs = []
  for (const item of byId.values()) {
    if (item.deleted) {
      if (ttl > 0 && item.deletedAt && now - item.deletedAt > ttl) continue
      tombs.push(item)
    } else {
      live.push(item)
    }
  }
  live.sort(compareComments)
  tombs.sort(compareComments)
  if (live.length > maxPerNode) live = live.slice(live.length - maxPerNode)
  if (tombs.length > COMMENT_MAX_TOMBSTONES) tombs = tombs.slice(tombs.length - COMMENT_MAX_TOMBSTONES)
  return live.concat(tombs)
}

export function liveComments(list) {
  return mergeComments([], list, { tombstoneTtlMs: 0 }).filter(item => !item.deleted)
}

