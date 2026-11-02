let activeRun = null
let lastClickAt = 0

// One owner for the snapshot, animation, timers and cleanup. Skipping a native
// view transition alone does not reliably settle its separate Web Animation.
export async function revealThemeChange({ element, originElement = element, update, nextTick, onRepeat, animate = true, document: doc = document, window: win = window }) {
  const now = Date.now()
  const rapidClick = now - lastClickAt < 180
  lastClickAt = now
  const interrupted = !!activeRun
  if (activeRun) activeRun.cancel()
  const reducedMotion = win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!animate || !doc.startViewTransition || reducedMotion || rapidClick || interrupted) {
    update()
    return
  }

  const root = doc.documentElement
  const bounds = element.getBoundingClientRect()
  const originBounds = originElement.getBoundingClientRect()
  const x = Math.max(0, Math.min(win.innerWidth, originBounds.left + originBounds.width / 2))
  const y = Math.max(0, Math.min(win.innerHeight, originBounds.top + originBounds.height / 2))
  const radius = Math.ceil(Math.hypot(Math.max(x, win.innerWidth - x), Math.max(y, win.innerHeight - y)))
  let release
  const cancelled = new Promise(resolve => { release = resolve })
  let applied = false
  let transition, animation, captureTimer, finishTimer
  // Some Chromium versions retarget clicks on the snapshot to <html>, even
  // with pointer-events disabled on every transition pseudo-element.
  const forwardSnapshotClick = event => {
    if (!onRepeat || element.contains(event.target)) return
    if (event.clientX < bounds.left || event.clientX > bounds.left + bounds.width ||
        event.clientY < bounds.top || event.clientY > bounds.top + bounds.height) return
    event.preventDefault()
    event.stopImmediatePropagation()
    onRepeat({ currentTarget: element, clientX: event.clientX, clientY: event.clientY })
  }
  const cancelOnScroll = () => { apply(); run.cancel() }
  const run = {
    cancelled: false,
    cancel() {
      if (run.cancelled) return
      run.cancelled = true
      clearTimeout(captureTimer)
      clearTimeout(finishTimer)
      if (doc.removeEventListener) {
        doc.removeEventListener('click', forwardSnapshotClick, true)
        doc.removeEventListener('scroll', cancelOnScroll, true)
      }
      if (animation && animation.cancel) animation.cancel()
      if (transition) transition.skipTransition()
      if (activeRun === run) {
        activeRun = null
        root.classList.remove('themeModeReveal')
      }
      release()
    }
  }
  const apply = () => {
    if (!applied && !run.cancelled) { applied = true; update() }
  }
  activeRun = run
  if (doc.addEventListener) {
    doc.addEventListener('click', forwardSnapshotClick, true)
    doc.addEventListener('scroll', cancelOnScroll, true)
  }
  root.classList.add('themeModeReveal')
  try {
    transition = doc.startViewTransition(async () => {
      apply()
      await nextTick()
      // Rendering is paused here: never wait for requestAnimationFrame.
    })
    // Observe native completion, but do not wait on it after a separate custom
    // animation: unrelated animations/removed pseudo-elements can delay it.
    transition.finished.catch(() => {})
    captureTimer = setTimeout(() => { apply(); run.cancel() }, 220)
    const ready = await Promise.race([
      transition.ready.then(() => true, () => false),
      cancelled.then(() => false)
    ])
    clearTimeout(captureTimer)
    if (!ready || run.cancelled) { apply(); return }
    animation = root.animate({
      clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`]
    }, {
      duration: 420,
      easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
      fill: 'both',
      pseudoElement: '::view-transition-new(root)'
    })
    const animationDone = animation.finished.catch(() => {})
    finishTimer = setTimeout(() => run.cancel(), 650)
    await Promise.race([animationDone, cancelled])
  } catch (_) {
    apply()
  } finally {
    run.cancel()
  }
}
