class SyncScheduler {
  constructor({ list, reconcile, log = console.error, debounceMs = 2000, intervalMs = 300000 }) {
    this.list = list; this.reconcile = reconcile; this.log = log
    this.debounceMs = debounceMs; this.intervalMs = intervalMs
    this.tail = Promise.resolve()
    this.states = new Map(); this.stopped = false; this.ticking = null
  }
  state(id) {
    if (!this.states.has(id)) this.states.set(id, { dirty: false, running: null, timer: null })
    return this.states.get(id)
  }
  notify(id) {
    if (!id || this.stopped) return
    const st = this.state(id); st.dirty = true
    clearTimeout(st.timer)
    if (st.running) return
    st.timer = setTimeout(() => { st.timer = null; this.flush(id).catch(e => this.log('[WikiCompiler] ' + e.message)) }, this.debounceMs)
    st.timer.unref?.()
  }
  async flush(id) {
    const st = this.state(id)
    clearTimeout(st.timer); st.timer = null
    if (st.running) { st.dirty = true; return st.running }
    if (this.stopped) return
    st.dirty = true
    st.running = this.tail.then(async () => {
      do {
        st.dirty = false
        try { await this.reconcile(id) }
        catch (error) { this.log(`[WikiCompiler][room=${id}] failed: ${error.message}`) }
      } while (st.dirty && !this.stopped)
    }).finally(() => { st.running = null })
    this.tail = st.running.catch(() => {})
    return st.running
  }
  tick() {
    if (this.stopped) return Promise.resolve()
    if (this.ticking) return this.ticking
    this.ticking = (async () => {
      for (const id of await this.list()) { if (this.stopped) break; await this.flush(id) }
    })().catch(e => this.log('[WikiCompiler] reconciliation failed: ' + e.message)).finally(() => { this.ticking = null })
    return this.ticking
  }
  start() {
    this.timer = setInterval(() => this.tick(), this.intervalMs)
    this.timer.unref?.()
    return this.tick()
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer)
    for (const st of this.states.values()) clearTimeout(st.timer)
    await Promise.all([...this.states.values()].map(st => st.running).filter(Boolean))
  }
}
module.exports = { SyncScheduler }
