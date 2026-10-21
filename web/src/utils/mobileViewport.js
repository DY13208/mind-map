// Keep the responsive boundary shared without persisting device-specific state.
export default {
  data: () => ({ isMobileViewport: false }),
  mounted() {
    this._mobileQuery = window.matchMedia('(max-width: 767px)')
    this.updateMobileViewport()
    this._mobileQuery.addListener(this.updateMobileViewport)
  },
  beforeDestroy() {
    if (this._mobileQuery) this._mobileQuery.removeListener(this.updateMobileViewport)
  },
  methods: {
    updateMobileViewport() { this.isMobileViewport = this._mobileQuery.matches }
  }
}
