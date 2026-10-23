// 右键菜单 / 子菜单定位：纯函数，便于单测。
// 所有矩形均为视口坐标 { left, top, right, bottom }。

export const MENU_MARGIN = 8
export const FRAME_WIDTH = 4 // 与 style/notch.less @mm-frame-width 保持一致
export const NOTCH_HEIGHT_TOP = 48 // @mm-notch-height
export const NOTCH_HEIGHT_BOTTOM = 42 // @mm-notch-height-bottom
const MIN_USABLE_HEIGHT = 120

const toRect = r => ({
  left: r.left,
  top: r.top,
  right: r.right != null ? r.right : r.left + (r.width || 0),
  bottom: r.bottom != null ? r.bottom : r.top + (r.height || 0)
})

// 视口减去外框和边距
export function getSafeArea(viewport, margin = MENU_MARGIN, frame = FRAME_WIDTH) {
  const inset = margin + frame
  const width = viewport.width
  const height = viewport.height
  return {
    left: Math.min(inset, width / 2),
    top: Math.min(inset, height / 2),
    right: Math.max(width - inset, width / 2),
    bottom: Math.max(height - inset, height / 2)
  }
}

// 根据与 [left, right] 水平相交的障碍物（刘海条）收窄可用的垂直区间。
// 位于上半部分的障碍物抬高 top，下半部分的压低 bottom。
export function narrowArea(safeArea, obstacles, left, right, gap = MENU_MARGIN) {
  const area = { ...safeArea }
  const mid = (safeArea.top + safeArea.bottom) / 2
  ;(obstacles || []).forEach(raw => {
    if (!raw) return
    const o = toRect(raw)
    if (o.right <= o.left || o.bottom <= o.top) return
    if (o.right <= left || o.left >= right) return
    if ((o.top + o.bottom) / 2 < mid) area.top = Math.max(area.top, o.bottom + gap)
    else area.bottom = Math.min(area.bottom, o.top - gap)
  })
  // 障碍物把空间挤得太小时宁可压在刘海上，也不要让菜单不可用
  if (area.bottom - area.top < MIN_USABLE_HEIGHT) return { ...safeArea }
  return area
}

const clamp = (v, min, max) => Math.max(min, Math.min(v, max))

/**
 * 主菜单定位
 * @param size { width, height } 菜单自然尺寸（未截断的内容高度）
 * @param anchor { x, y } 鼠标位置
 * @param safeArea 安全区
 * @param opts { offset, obstacles }
 * @returns { left, top, maxHeight, openLeft, openUp }
 */
export function placeMenu(size, anchor, safeArea, opts = {}) {
  const offset = opts.offset == null ? 10 : opts.offset
  const width = Math.min(size.width, safeArea.right - safeArea.left)
  let left
  let openLeft = false
  if (anchor.x + offset + width <= safeArea.right) {
    left = anchor.x + offset
  } else if (anchor.x - offset - width >= safeArea.left) {
    left = anchor.x - offset - width
    openLeft = true
  } else {
    left = clamp(anchor.x + offset, safeArea.left, safeArea.right - width)
  }
  const area = narrowArea(safeArea, opts.obstacles, left, left + width)
  const maxHeight = Math.max(0, area.bottom - area.top)
  const height = Math.min(size.height, maxHeight)
  let top
  let openUp = false
  if (anchor.y + offset + height <= area.bottom) {
    top = Math.max(anchor.y + offset, area.top)
  } else if (anchor.y - offset - height >= area.top) {
    top = anchor.y - offset - height
    openUp = true
  } else {
    top = clamp(anchor.y + offset, area.top, area.bottom - height)
  }
  return { left, top, maxHeight, openLeft, openUp }
}

/**
 * 子菜单定位
 * @param size { width, height } 子菜单自然尺寸
 * @param itemRect 触发项矩形
 * @param parentRect 主菜单矩形
 * @param safeArea 安全区
 * @param opts { gap, alignOffset, obstacles }
 * @returns { left, top, maxHeight, flipped }
 */
export function placeSubmenu(size, itemRect, parentRect, safeArea, opts = {}) {
  const gap = opts.gap == null ? 4 : opts.gap
  const alignOffset = opts.alignOffset == null ? 6 : opts.alignOffset // listBox 内边距
  const item = toRect(itemRect)
  const parent = toRect(parentRect || itemRect)
  const width = Math.min(size.width, safeArea.right - safeArea.left)
  const rightLeft = parent.right + gap
  const leftLeft = parent.left - gap - width
  let left
  let flipped = false
  if (rightLeft + width <= safeArea.right) {
    left = rightLeft
  } else if (leftLeft >= safeArea.left) {
    left = leftLeft
    flipped = true
  } else {
    // 两侧都放不下：放在空间更大的一侧并夹紧
    const roomRight = safeArea.right - parent.right
    const roomLeft = parent.left - safeArea.left
    flipped = roomLeft > roomRight
    left = clamp(flipped ? leftLeft : rightLeft, safeArea.left, safeArea.right - width)
  }
  const area = narrowArea(safeArea, opts.obstacles, left, left + width)
  const maxHeight = Math.max(0, area.bottom - area.top)
  const height = Math.min(size.height, maxHeight)
  let top = item.top - alignOffset
  if (top + height > area.bottom) top = area.bottom - height
  if (top < area.top) top = area.top
  return { left, top, maxHeight, flipped }
}

// ---- DOM 辅助（非纯函数，组件中使用） ----

const OBSTACLE_SELECTORS = [
  '.toolbarContainer .fileDock > .toolbarBlock',
  '.toolbarContainer .collabDock > .toolbarBlock',
  '.countContainer',
  '.navigatorToolbarWrapper'
]

export function collectObstacles(doc) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return []
  const rects = []
  OBSTACLE_SELECTORS.forEach(selector => {
    doc.querySelectorAll(selector).forEach(el => {
      const r = el.getBoundingClientRect && el.getBoundingClientRect()
      if (r && r.width > 0 && r.height > 0) rects.push(toRect(r))
    })
  })
  return rects
}

// Current frame width from the themeable CSS var (light 0, dark 4px); falls back to FRAME_WIDTH.
export function readFrameWidth(win) {
  try {
    const body = win && win.document && win.document.body
    if (!body || typeof win.getComputedStyle !== 'function') return FRAME_WIDTH
    const raw = win.getComputedStyle(body).getPropertyValue('--mm-frame-width')
    const v = parseFloat(raw)
    return Number.isFinite(v) && v >= 0 ? v : FRAME_WIDTH
  } catch (e) {
    return FRAME_WIDTH
  }
}

export function getViewport(win) {
  return {
    width: (win && win.innerWidth) || 0,
    height: (win && win.innerHeight) || 0
  }
}

// Touch / narrow viewports cannot keep a flyout submenu on screen.
export function preferStackedSubmenu(viewport, opts = {}) {
  if (opts.isMobile || opts.coarsePointer) return true
  const width = (viewport && viewport.width) || 0
  const height = (viewport && viewport.height) || 0
  if (width <= 0 || height <= 0) return false
  return width < 768 || height < 500
}