/**
 * 协作模式下的数据兜底。
 *
 * 背景（2026-09-23 实测）：页面 URL 带房间号时，前端把持久化**完全交给协作服务**
 * （`api/index.js` 的 `storeData` 在协作会话里既不写 localStorage 也不写 IndexedDB）。
 * 一旦协作服务挂了 / nginx 转发 502，数据就只活在内存里 —— 刷新或重新部署后整张图消失。
 *
 * 现在协作会话也会往本地 IndexedDB 留一份草稿，这里负责判断「什么时候该用它把图恢复出来」。
 * 抽成纯函数是为了好测：这段判断（尤其"别覆盖已有的图"）最容易写错。
 */

/** 等这么久还没连上协作，就用本地留底恢复（给协作握手留足时间） */
export const COLLAB_DRAFT_FALLBACK_MS = 10000

/**
 * 兜底恢复的开关。默认开；出问题时在控制台执行
 * `window.__COLLAB_DRAFT_FALLBACK__ = false` 再刷新即可关掉（不改代码、不用重新部署）。
 */
export function isDraftFallbackEnabled(win) {
  const target = win || (typeof window !== 'undefined' ? window : null)
  if (!target) return true
  return target.__COLLAB_DRAFT_FALLBACK__ !== false
}

/**
 * 该不该用本地留底的草稿恢复。
 *
 * @param {Object}  options
 * @param {Boolean} options.live   协作是否已连上（collabPhase==='LIVE' 或 cooperateStatus==='connected'）
 * @param {Object}  options.draft  本地留底的草稿（`{ root, ... }`）
 * @param {Object}  options.root   当前图里已有的 root —— 已经有内容就绝不覆盖
 */
export function shouldRestoreDraft({ live, draft, root } = {}) {
  // 协作通了就以协作为准，别拿本地旧数据去打架
  if (live) return false
  if (!draft || !draft.root) return false
  if (typeof draft.root !== 'object') return false
  const kids = (root && root.children) || []
  // 图上已经有东西了（协作其实通了、或用户已经编辑过）就别动
  if (kids.length > 0) return false
  return true
}

/** 恢复草稿时给用户看的说明 */
export function draftRestoredTip(draft) {
  const kids = (draft && draft.root && draft.root.children) || []
  return (
    '协作服务没连上，已用本地留底的草稿把这张图恢复出来' +
    `（顶层 ${kids.length} 个分支）。` +
    '服务器上的协作服务起来后，改动会自动同步过去。'
  )
}
