// Editor chrome follows available width and touch input, independently of the
// phone-only product navigation. This also covers iPad's desktop user agent.
export const TOUCH_EDITOR_QUERY = '(max-width: 767px), (max-width: 1366px) and (any-pointer: coarse)'
export default {
  data: () => ({ isTouchEditor: typeof window !== 'undefined' && window.matchMedia(TOUCH_EDITOR_QUERY).matches }),
  mounted() {
    this._editorViewportQuery = window.matchMedia(TOUCH_EDITOR_QUERY)
    this.updateEditorViewport()
    this._editorViewportQuery.addListener(this.updateEditorViewport)
  },
  beforeDestroy() {
    if (this._editorViewportQuery) this._editorViewportQuery.removeListener(this.updateEditorViewport)
  },
  methods: {
    updateEditorViewport() { this.isTouchEditor = this._editorViewportQuery.matches }
  }
}
