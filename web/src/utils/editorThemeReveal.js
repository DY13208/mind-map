import { revealThemeChange } from './themeReveal'

// Use the same snapshot owner as the file toolbar; wait for the graph's queued
// theme render without waiting for animation frames while capture is paused.
export function revealEditorThemeChange({ element, mindMap, update, nextTick, onRepeat, animate = true }) {
  const canvas = document.querySelector('.mindMapContainer')
  let finishRender, timer
  const rendered = new Promise(resolve => { finishRender = resolve })
  const onRendered = () => finishRender()
  const cleanup = () => {
    clearTimeout(timer)
    if (mindMap) mindMap.off('node_tree_render_end', onRendered)
    finishRender()
  }
  return revealThemeChange({
    element,
    originElement: canvas || element,
    animate,
    onRepeat,
    update: () => {
      if (mindMap) mindMap.on('node_tree_render_end', onRendered)
      timer = setTimeout(finishRender, 140)
      update()
    },
    nextTick: async () => {
      await nextTick()
      if (mindMap) await rendered
    }
  }).finally(cleanup)
}

export function findThemeClickTarget(container, event, selector) {
  return Array.from(container.querySelectorAll(selector)).find(element => {
    const rect = element.getBoundingClientRect()
    return event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom
  })
}
