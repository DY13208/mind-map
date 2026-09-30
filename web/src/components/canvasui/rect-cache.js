// Canvas UI rect cache, David Haz (2026), MIT + Commons Clause. See LICENSE.md.
// Adapted for the fixed login background: scrolling cannot move this canvas.
export function createRectCache(element) {
  let current = element.getBoundingClientRect()
  const refresh = () => { current = element.getBoundingClientRect() }
  const observer = new ResizeObserver(refresh)
  observer.observe(element)
  window.addEventListener('resize', refresh, { passive: true })
  return {
    get current() { return current },
    destroy() {
      observer.disconnect()
      window.removeEventListener('resize', refresh)
    }
  }
}
