// Track only active reads. Delete/restore invalidates their original UID
// lifetime, even when the UID is live again by the time an old response arrives.
const activeByOwner = new WeakMap()
const sessionByOwner = new WeakMap()

function beginHydration(owner, uid) {
  if (!sessionByOwner.has(owner)) sessionByOwner.set(owner, {})
  const session = sessionByOwner.get(owner)
  let states = activeByOwner.get(owner)
  if (!states) {
    states = new Map()
    activeByOwner.set(owner, states)
  }
  let state = states.get(uid)
  if (!state) {
    state = { generation: 0, readers: 0 }
    states.set(uid, state)
  }
  state.readers += 1
  const generation = state.generation
  const roomKey = owner.httpRoomKey
  let released = false
  return {
    isCurrent: () => !released && state.generation === generation &&
      sessionByOwner.get(owner) === session &&
      owner.httpRoomKey === roomKey &&
      (typeof owner.isTombstonedUid !== 'function' || !owner.isTombstonedUid(uid)),
    release() {
      if (released) return
      released = true
      state.readers -= 1
      if (!state.readers && states.get(uid) === state) states.delete(uid)
      if (!states.size && activeByOwner.get(owner) === states) activeByOwner.delete(owner)
    }
  }
}

function invalidateHydrationSession(owner) {
  sessionByOwner.set(owner, {})
  activeByOwner.delete(owner)
}

function invalidateHydration(owner, uid) {
  const states = activeByOwner.get(owner)
  const state = states && states.get(uid)
  if (state) state.generation += 1
}

module.exports = { beginHydration, invalidateHydration, invalidateHydrationSession }
