// 节点超链接图标的点击行为
// - popover（默认）：不直接跳转，交给上层弹出链接操作条
// - open：保持旧行为，直接打开链接
// 按住 Ctrl/Cmd 点击时始终直接打开。
// 返回值：'popover' | 'custom'（使用 customHyperlinkJump）| 'native'（交给 <a> 默认行为）
export const resolveHyperlinkClick = ({ mode, event, customHyperlinkJump } = {}) => {
  const modifier = !!(event && (event.ctrlKey || event.metaKey))
  if (mode !== 'open' && !modifier) return 'popover'
  return typeof customHyperlinkJump === 'function' ? 'custom' : 'native'
}

export default { resolveHyperlinkClick }
