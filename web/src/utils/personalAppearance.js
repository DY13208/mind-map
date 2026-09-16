const PREFIX = 'mind-map-personal-appearance:v1:'
const copy = value => JSON.parse(JSON.stringify(value))

// Only map presentation is personal. Node style/content remains collaborative.
export function bindPersonalAppearance(mindMap, roomKey, userId, getState, saveState) {
  const key = `${PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(roomKey)}`
  let state = {}
  try { state = JSON.parse(localStorage.getItem(key) || '{}') || {} } catch (err) {}
  let applying = false
  let stopped = false
  let dirty = false
  let timer = null
  const cache = () => {
    try { localStorage.setItem(key, JSON.stringify(state)) } catch (err) {}
  }
  const persist = () => saveState(roomKey, copy(state)).catch(() => {})
  const restore = () => {
    if (stopped || applying || !Object.keys(state).length) return
    const current = {
      theme: mindMap.getTheme(),
      themeConfig: mindMap.getCustomThemeConfig() || {},
      layout: mindMap.getLayout()
    }
    const next = { ...current, ...state }
    if (JSON.stringify(current) === JSON.stringify(next)) return
    applying = true
    try {
      const layoutChanged = next.layout !== current.layout
      const themeChanged = next.theme !== current.theme ||
        JSON.stringify(next.themeConfig) !== JSON.stringify(current.themeConfig)
      mindMap.opt.theme = next.theme
      mindMap.opt.themeConfig = copy(next.themeConfig)
      if (layoutChanged) {
        mindMap.opt.layout = next.layout
        mindMap.renderer.setLayout()
      }
      if (themeChanged) mindMap.initTheme()
      mindMap.render(null, themeChanged ? 'changeTheme' : 'changeLayout')
      if (themeChanged) mindMap.emit('view_theme_change', next.theme)
      if (layoutChanged) mindMap.emit('layout_change', next.layout)
    } finally { applying = false }
  }
  const changed = () => {
    if (stopped || applying || (mindMap.cooperate && mindMap.cooperate.isApplyingRemote)) return
    dirty = true
    state = copy({
      theme: mindMap.getTheme(),
      themeConfig: mindMap.getCustomThemeConfig() || {},
      layout: mindMap.getLayout()
    })
    cache()
    clearTimeout(timer)
    timer = setTimeout(persist, 350)
  }
  const events = ['view_theme_change', 'view_theme_config_change', 'layout_change']
  events.forEach(event => mindMap.on(event, changed))
  mindMap.on('node_tree_render_end', restore)
  restore()
  getState(roomKey).then(result => {
    // A delayed server response must not undo an edit made while it was loading.
    if (stopped || dirty) return
    const remote = result && result.state || {}
    for (const field of ['theme', 'themeConfig', 'layout']) {
      if (Object.prototype.hasOwnProperty.call(remote, field)) state[field] = copy(remote[field])
    }
    cache()
    restore()
  }).catch(() => {})
  return () => {
    stopped = true
    clearTimeout(timer)
    events.forEach(event => mindMap.off(event, changed))
    mindMap.off('node_tree_render_end', restore)
    if (dirty) persist()
  }
}
