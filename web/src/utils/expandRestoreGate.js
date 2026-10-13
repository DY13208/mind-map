// Compare inexpensive identities/version markers, never serialize the tree.
export function createExpandRestoreGate() {
  let previous = null
  return {
    shouldRestore(tree, revision, state, localRevision) {
      const next = [tree, revision, state, localRevision]
      if (previous && next.every((value, index) => value === previous[index])) return false
      previous = next
      return true
    },
    invalidate() { previous = null }
  }
}
