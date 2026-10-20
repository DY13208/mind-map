const MOVE_THRESHOLD = 10
const DOUBLE_TAP_DELAY = 300
const LONG_PRESS_DELAY = 500

// Only gestures that start on this canvas belong to the map. The mouse bridge
// keeps node selection/dragging on the same command and permission paths as a mouse.
class TouchEvent {
  constructor({ mindMap }) {
    this.mindMap = mindMap
    this.mode = null
    this.mouseDown = false
    this.lastTap = null
    this.longPressTimer = null
    this.touchStartScaleView = null
    this.bindEvent()
  }

  bindEvent() {
    this.onTouchstart = this.onTouchstart.bind(this)
    this.onTouchmove = this.onTouchmove.bind(this)
    this.onTouchcancel = this.onTouchcancel.bind(this)
    this.onTouchend = this.onTouchend.bind(this)
    this.onVisibilityChange = this.onVisibilityChange.bind(this)
    const el = this.mindMap.el
    this.previousTouchAction = el.style.touchAction
    this.previousTouchCallout = el.style.webkitTouchCallout
    el.style.touchAction = 'none'
    el.style.webkitTouchCallout = 'none'
    el.addEventListener('touchstart', this.onTouchstart, { passive: false })
    window.addEventListener('touchmove', this.onTouchmove, { passive: false })
    window.addEventListener('touchend', this.onTouchend, { passive: false })
    window.addEventListener('touchcancel', this.onTouchcancel, { passive: false })
    window.addEventListener('blur', this.onTouchcancel)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
  }

  unBindEvent() {
    this.onTouchcancel()
    const el = this.mindMap.el
    el.removeEventListener('touchstart', this.onTouchstart)
    window.removeEventListener('touchmove', this.onTouchmove)
    window.removeEventListener('touchend', this.onTouchend)
    window.removeEventListener('touchcancel', this.onTouchcancel)
    window.removeEventListener('blur', this.onTouchcancel)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    el.style.touchAction = this.previousTouchAction
    el.style.webkitTouchCallout = this.previousTouchCallout
  }

  getTouches(e) {
    return Array.from(e.touches || []).filter(touch =>
      this.mindMap.el.contains(touch.target)
    )
  }

  preventDefault(e) {
    if (e.cancelable) e.preventDefault()
  }

  clearLongPress() {
    clearTimeout(this.longPressTimer)
    this.longPressTimer = null
  }

  onTouchstart(e) {
    const target = e.target.nodeType === 3 ? e.target.parentElement : e.target
    // Text editing, links and native controls must retain their own touch behavior.
    if (target.closest && target.closest('input,textarea,select,button,a,[contenteditable="true"],[contenteditable=""]')) return
    const touches = this.getTouches(e)
    if (!touches.length) return
    this.preventDefault(e)
    if (touches.length >= 2) this.beginPinch(touches)
    else if (!this.mode) this.beginSingle(touches[0])
  }

  beginSingle(touch, panOnly = false) {
    this.clearLongPress()
    this.mode = 'single'
    this.startTouch = touch
    this.lastTouch = touch
    this.moved = panOnly
    const target = touch.target.nodeType === 3 ? touch.target.parentElement : touch.target
    this.tapTarget = target.closest ? target.closest('.smm-node') || target : target
    const root = this.mindMap.renderer && this.mindMap.renderer.root
    const rootEl = root && root.group && root.group.node
    const nodeTouch = target.closest && target.closest('.smm-node')
    // Middle-button canvas panning works regardless of the user's desktop
    // left-selection/right-drag preference. Editable nodes retain left dragging.
    this.mouseButton = !panOnly && nodeTouch && !this.mindMap.opt.readonly &&
      !(rootEl && rootEl.contains(target)) ? 0 : 1
    this.mouseTarget = panOnly ? this.mindMap.el : target
    this.mouseDown = true
    this.dispatchMouseEvent('mousedown', this.mouseTarget, touch)
    if (!panOnly && nodeTouch && !this.mindMap.opt.readonly) {
      this.longPressTimer = setTimeout(() => {
        const point = this.lastTouch
        const menuTarget = this.mouseTarget
        this.cancelMouseGesture()
        this.mode = 'longpress'
        this.lastTap = null
        this.dispatchMouseEvent('mousedown', menuTarget, point, 2)
        this.dispatchMouseEvent('mouseup', menuTarget, point, 2)
        this.dispatchMouseEvent('contextmenu', menuTarget, point, 2)
      }, LONG_PRESS_DELAY)
    }
  }

  cancelMouseGesture() {
    this.clearLongPress()
    if (!this.mouseDown) return
    // A second finger or an OS cancellation must abort, rather than commit,
    // a pending node drop (including its asynchronous hydration/preview).
    if (this.mindMap.drag) this.mindMap.drag.cancelDrag()
    if (this.mindMap.select) this.mindMap.select.clearSelectionState()
    this.mouseDown = false
    this.dispatchMouseEvent('mouseup', this.mindMap.el, this.lastTouch)
  }

  beginPinch(touches) {
    this.cancelMouseGesture()
    this.lastTap = null
    this.mode = 'pinch'
    const { distance, cx, cy } = this.getPinchPosition(touches)
    const view = this.mindMap.view
    this.touchStartScaleView = { distance, cx, cy, scale: view.scale, x: view.x, y: view.y }
  }

  getPinchPosition(touches) {
    const [a, b] = touches
    const center = this.mindMap.toPos((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2)
    return { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), cx: center.x, cy: center.y }
  }

  onTouchmove(e) {
    if (!this.mode) return
    if (e.changedTouches && !Array.from(e.changedTouches).some(touch => this.mindMap.el.contains(touch.target))) return
    const touches = this.getTouches(e)
    if (!touches.length) return
    this.preventDefault(e)
    if (touches.length >= 2) {
      if (this.mode !== 'pinch') this.beginPinch(touches)
      const { distance, cx, cy } = this.getPinchPosition(touches)
      const before = this.touchStartScaleView
      if (before.distance <= 0 || before.scale <= 0) {
        this.beginPinch(touches)
        return
      }
      const opt = this.mindMap.opt
      const min = opt.minTouchZoomScale === -1 ? 0.01 : (opt.minTouchZoomScale || 20) / 100
      const max = opt.maxTouchZoomScale == null || opt.maxTouchZoomScale === -1
        ? Infinity : opt.maxTouchZoomScale / 100
      const scale = opt.disableTouchZoom ? before.scale : Math.max(min, Math.min(max, before.scale * distance / before.distance))
      const ratio = scale / before.scale
      const view = this.mindMap.view
      view.scale = scale
      // Keep the original map point under the fingers, at every zoom level.
      view.x = (opt.isDisableDrag ? before.cx : cx) - (before.cx - before.x) * ratio
      view.y = (opt.isDisableDrag ? before.cy : cy) - (before.cy - before.y) * ratio
      view.transform()
      this.mindMap.emit('scale', scale)
    } else if (this.mode === 'single') {
      const touch = touches[0]
      this.lastTouch = touch
      if (Math.hypot(touch.clientX - this.startTouch.clientX, touch.clientY - this.startTouch.clientY) > MOVE_THRESHOLD) {
        this.moved = true
        this.lastTap = null
        this.clearLongPress()
      }
      if (this.moved) this.dispatchMouseEvent('mousemove', this.mouseTarget, touch)
    }
  }

  onTouchend(e) {
    if (!this.mode) return
    if (e.changedTouches && !Array.from(e.changedTouches).some(touch => this.mindMap.el.contains(touch.target))) return
    const touches = this.getTouches(e)
    this.preventDefault(e)
    if (touches.length >= 2) {
      this.beginPinch(touches)
      return
    }
    if (touches.length === 1) {
      // Continuing after a pinch pans from the remaining finger's current
      // position; it cannot accidentally turn into a node drag or a double tap.
      this.cancelMouseGesture()
      this.touchStartScaleView = null
      this.beginSingle(touches[0], true)
      return
    }
    this.clearLongPress()
    const point = Array.from(e.changedTouches || []).find(touch =>
      this.startTouch && touch.identifier === this.startTouch.identifier
    ) || this.lastTouch
    if (point && this.startTouch && Math.hypot(point.clientX - this.startTouch.clientX, point.clientY - this.startTouch.clientY) > MOVE_THRESHOLD) this.moved = true
    if (this.mouseDown) {
      this.mouseDown = false
      this.dispatchMouseEvent('mouseup', this.mouseTarget, point)
    }
    if (this.mode === 'single' && !this.moved && point) {
      const now = Date.now()
      const last = this.lastTap
      this.dispatchMouseEvent('click', this.mouseTarget, point, 0)
      if (last && now - last.time < DOUBLE_TAP_DELAY && last.target === this.tapTarget &&
        Math.hypot(point.clientX - last.x, point.clientY - last.y) <= 24) {
        this.dispatchMouseEvent('dblclick', this.mouseTarget, point, 0)
        this.lastTap = null
      } else {
        this.lastTap = { time: now, target: this.tapTarget, x: point.clientX, y: point.clientY }
      }
    }
    this.mode = null
    this.startTouch = null
    this.lastTouch = null
    this.touchStartScaleView = null
  }

  onTouchcancel(e) {
    if (e && e.changedTouches && !Array.from(e.changedTouches).some(touch => this.mindMap.el.contains(touch.target))) return
    this.cancelMouseGesture()
    this.mode = null
    this.startTouch = null
    this.lastTouch = null
    this.lastTap = null
    this.touchStartScaleView = null
  }

  onVisibilityChange() {
    if (document.hidden) this.onTouchcancel()
  }

  dispatchMouseEvent(eventName, target, point, button = this.mouseButton) {
    if (!target || !point) return
    const event = new MouseEvent(eventName, {
      view: document.defaultView,
      bubbles: true,
      cancelable: true,
      screenX: point.screenX,
      screenY: point.screenY,
      clientX: point.clientX,
      clientY: point.clientY,
      button,
      buttons: eventName === 'mouseup' || eventName === 'click' || eventName === 'dblclick'
        ? 0 : button === 1 ? 4 : button === 2 ? 2 : 1,
      detail: eventName === 'dblclick' ? 2 : 1
    })
    target.dispatchEvent(event)
  }

  beforePluginRemove() { this.unBindEvent() }
  beforePluginDestroy() { this.unBindEvent() }
}

TouchEvent.instanceName = 'touchEvent'
export default TouchEvent
