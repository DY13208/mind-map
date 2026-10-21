// Safari's keyboard resizes the visual viewport without resizing the layout
// viewport. Keep fixed canvas chrome inside the visible area; browser page zoom
// retains its native behavior instead of changing the application's layout.
export function installMobileViewport(win = window, doc = document) {
  const root = doc.documentElement
  const viewport = win.visualViewport
  const previousHeight = root.style.getPropertyValue('--mm-viewport-height')
  const previousTop = root.style.getPropertyValue('--mm-viewport-top')
  let frame = null
  const update = () => {
    frame = null
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return
    const height = viewport ? viewport.height : win.innerHeight
    if (!Number.isFinite(height) || height <= 0) return
    root.style.setProperty('--mm-viewport-height', `${Math.round(height)}px`)
    root.style.setProperty('--mm-viewport-top', `${Math.max(0, Math.round(viewport ? viewport.offsetTop : 0))}px`)
  }
  const schedule = () => {
    if (frame === null) frame = win.requestAnimationFrame(update)
  }
  update()
  win.addEventListener('resize', schedule)
  if (viewport) {
    viewport.addEventListener('resize', schedule)
    viewport.addEventListener('scroll', schedule)
  }
  return () => {
    if (frame !== null) win.cancelAnimationFrame(frame)
    win.removeEventListener('resize', schedule)
    if (viewport) {
      viewport.removeEventListener('resize', schedule)
      viewport.removeEventListener('scroll', schedule)
    }
    for (const [name, value] of [['--mm-viewport-height', previousHeight], ['--mm-viewport-top', previousTop]]) {
      if (value) root.style.setProperty(name, value)
      else root.style.removeProperty(name)
    }
  }
}
