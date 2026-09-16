const fs = require('fs/promises')
const { safeId } = require('./utils')

function startScheduler(compiler, options = {}) {
  const interval = Math.max(1, Number(options.interval) || 300)
  let running = false, stopped = false
  async function tick() {
    if (running || stopped) return
    running = true
    try {
      // Never preload all room contents/Y.Docs. Scan only inexpensive room IDs.
      const rooms = (await compiler.pool.query(`select r.room_key from rooms r
        left join room_tombstones t using(room_key)
        where t.room_key is null and r.deleted_at is null order by r.room_key`)).rows.map(r => r.room_key)
      const live = new Set(rooms)
      // A crash between renames can leave no room path. Recover journaled rooms
      // as well, including rooms deleted while the compiler was stopped.
      let journaled = []
      try { journaled = await fs.readdir(require('path').join(compiler.outputDir, '.transactions')) }
      catch (err) { if (err.code !== 'ENOENT') throw err }
      for (const roomId of journaled) {
        try { await compiler.compile(roomId) } catch (_) { /* next tick retries */ }
      }
      for (const roomId of rooms) {
        if (stopped) break
        try { await compiler.compile(roomId) } catch (_) { /* compiler logs; next tick retries from durable version */ }
      }
      // Reconcile deletions even if the notification was missed while stopped.
      await fs.mkdir(compiler.outputDir, { recursive: true, mode: 0o700 })
      for (const item of await fs.readdir(compiler.outputDir, { withFileTypes: true })) {
        if (!item.isDirectory() || item.name.startsWith('.') || live.has(item.name)) continue
        try { safeId(item.name); await compiler.compile(item.name) }
        catch (err) { compiler.log(`[KnowledgeCompiler] archive retry: ${err.message}`) }
      }
    } catch (err) { compiler.log(`[KnowledgeCompiler] scheduler failed: ${err.message}`) }
    finally { running = false }
  }
  const timer = setInterval(() => { tick().catch(() => {}) }, interval * 1000)
  timer.unref()
  setImmediate(() => { tick().catch(() => {}) })
  return { tick, stop() { stopped = true; clearInterval(timer) } }
}
module.exports = { startScheduler }
