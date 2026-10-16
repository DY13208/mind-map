// 贡献天际线（Contribution Skyline）纯逻辑：无 DOM 依赖，便于单测。
export const DAY_MS = 86400000
export const WAVE = 0.42
export const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
export const LEVEL_NAMES = ['无编辑', '较少', '中等', '较多', '很多']

export const PALETTES = {
  github: {
    light: ['#c6e48b', '#7bc96f', '#239a3b', '#196127'],
    dark: ['#0e4429', '#006d32', '#26a641', '#39d353']
  },
  ocean: {
    light: ['#b8e1f2', '#6cb8e0', '#2b84c4', '#174f8c'],
    dark: ['#0c3550', '#125a85', '#2a8ccc', '#5ec0f2']
  },
  grape: {
    light: ['#e2cdf5', '#bf95e8', '#8d55cf', '#5b2a99'],
    dark: ['#3a1c5c', '#5c2e91', '#8c55d0', '#c08cf5']
  }
}

// 'YYYY-MM-DD' 按字面解析为 UTC 零点；数字/Date 直接取毫秒并归到 UTC 零点。
export function dayMs(v) {
  if (typeof v === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v)
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3])
  }
  const t = v instanceof Date ? v.getTime() : Number(v)
  return Math.floor(t / DAY_MS) * DAY_MS
}

export function toKey(ms) {
  const d = new Date(ms)
  const p = n => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

// 东八区（或任意偏移）的“今天”，以 UTC 零点毫秒表示。
export function todayMs(offsetMinutes = 480, now = Date.now()) {
  return dayMs(now + offsetMinutes * 60000)
}

export function percentile(sorted, p) {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

export function levelOf(count, busy) {
  if (count <= 0) return 0
  if (busy <= 0) return 4
  return 1 + Math.min(3, Math.floor((count / busy) * 4))
}

export function buildGrid(data, endMs, weekStart = 1) {
  const end = dayMs(endMs)
  const counts = new Map()
  ;(data || []).forEach(item => {
    if (!item) return
    const key = toKey(dayMs(item.date))
    counts.set(key, (counts.get(key) || 0) + (Number(item.count) || 0))
  })
  let start = end - 364 * DAY_MS
  const dow = new Date(start).getUTCDay()
  start -= ((dow - weekStart + 7) % 7) * DAY_MS
  const cells = []
  for (let t = start, i = 0; t <= end; t += DAY_MS, i++) {
    const date = toKey(t)
    cells.push({ date, ms: t, count: counts.get(date) || 0, level: 0, week: Math.floor(i / 7), day: i % 7 })
  }
  const nonzero = cells.map(c => c.count).filter(c => c > 0).sort((a, b) => a - b)
  const busy = percentile(nonzero, 0.95)
  cells.forEach(c => { c.level = levelOf(c.count, busy) })
  const weeks = cells.length ? cells[cells.length - 1].week + 1 : 0
  const max = nonzero.length ? nonzero[nonzero.length - 1] : 0
  return { cells, weeks, busy, max, start, end, weekStart }
}

export function computeStats(cells, endMs) {
  const end = dayMs(endMs)
  let total = 0
  let busiest = { count: 0, date: null }
  let longest = { days: 0, start: null, end: null }
  let run = 0
  let runStart = null
  cells.forEach(c => {
    total += c.count
    if (c.count > busiest.count) busiest = { count: c.count, date: c.date }
    if (c.count > 0) {
      if (run === 0) runStart = c.date
      run++
      if (run > longest.days) longest = { days: run, start: runStart, end: c.date }
    } else run = 0
  })
  const byDate = new Map(cells.map(c => [c.date, c.count]))
  let cursor = end
  if (!(byDate.get(toKey(cursor)) > 0)) cursor -= DAY_MS // 今天没编辑时允许从昨天算起
  let current = { days: 0, start: null, end: null }
  if (byDate.get(toKey(cursor)) > 0) {
    current.end = toKey(cursor)
    while (byDate.get(toKey(cursor)) > 0) {
      current.days++
      current.start = toKey(cursor)
      cursor -= DAY_MS
    }
  }
  return { total, busiest, longest, current }
}

export function monthLabels(cells) {
  const out = []
  let last = -1
  cells.forEach(c => {
    if (c.day !== 0) return
    const m = new Date(c.ms).getUTCMonth()
    if (m !== last) {
      out.push({ week: c.week, month: m, label: `${m + 1}月` })
      last = m
    }
  })
  if (out.length > 1 && out[1].week - out[0].week < 3) out.shift()
  return out
}

export function barHeight(count, max, scale = 1) {
  return count > 0 ? 0.4 + Math.pow(count / Math.max(1, max), 0.85) * 7.2 * scale : 0.2
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
export const lerp = (a, b, t) => a + (b - a) * t
export const easeOutCubic = t => 1 - Math.pow(1 - clamp(t, 0, 1), 3)
export const easeInOutCubic = t => {
  t = clamp(t, 0, 1)
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

export function riseAt(t, week, weeks, day) {
  const d = (week / Math.max(1, weeks - 1)) * 0.36 + (day / 6) * 0.06
  return easeOutCubic((t - d) / (1 - WAVE))
}

const DEG = Math.PI / 180
export function camera(e, dYaw = 0, dElev = 0) {
  const yaw = clamp(lerp(0, Math.PI / 4 + dYaw, e), 0, 82 * DEG)
  const elev = lerp(Math.PI / 2, clamp(34 * DEG + dElev, 18 * DEG, 62 * DEG), e)
  return { yaw, elev, cs: Math.cos(yaw), sn: Math.sin(yaw), ce: Math.cos(elev), se: Math.sin(elev) }
}

export function project(c, x, y, z) {
  return [x * c.cs - y * c.sn, (x * c.sn + y * c.cs) * c.se - z * c.ce]
}

export const depthOf = (c, x, y) => x * c.sn + y * c.cs

export function hexToRgb(hex) {
  const h = String(hex).replace('#', '')
  const f = h.length === 3 ? h.split('').map(x => x + x).join('') : h
  const n = parseInt(f, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
export const rgbToCss = (c, a = 1) =>
  a >= 1 ? `rgb(${c.map(Math.round).join(',')})` : `rgba(${c.map(Math.round).join(',')},${a})`
export const mixRgb = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)
export const shadeRgb = (c, k) => c.map(v => v * k)

export function emptyColor(bg, fg, dark) {
  return mixRgb(hexToRgb(bg), hexToRgb(fg), dark ? 0.11 : 0.075)
}

export function formatShortDate(key) {
  if (!key) return '—'
  const [, m, d] = key.split('-').map(Number)
  return `${m}月${d}日`
}
export function formatLongDate(key) {
  if (!key) return '—'
  const [y, m, d] = key.split('-').map(Number)
  return `${y}年${m}月${d}日`
}
export function formatTooltip(cell) {
  if (!cell) return ''
  const wd = WEEKDAY_NAMES[new Date(dayMs(cell.date)).getUTCDay()]
  const head = cell.count > 0 ? `${cell.count} 次编辑` : '无编辑'
  return `${head} · ${formatLongDate(cell.date)} ${wd}`
}

// 仅用于测试/样机：确定性伪随机数据，生产环境不调用。
export function sampleActivity(endMs, seed = 7) {
  let s = seed
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  const end = dayMs(endMs)
  const out = []
  for (let i = 370; i >= 0; i--) {
    const t = end - i * DAY_MS
    const dow = new Date(t).getUTCDay()
    const weekend = dow === 0 || dow === 6
    const season = 0.5 + 0.5 * Math.sin((i / 370) * Math.PI * 3)
    const r = rnd()
    if (r < (weekend ? 0.6 : 0.22)) continue
    out.push({ date: toKey(t), count: Math.round(rnd() * 14 * season * (weekend ? 0.4 : 1) + rnd() * 4) })
  }
  return out
}
