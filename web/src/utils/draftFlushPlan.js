export function shouldDeferDraftTreeCopy({
  force,
  flagEnabled,
  hasPendingTree,
  remainingMs
} = {}) {
  return !force && !!flagEnabled && !!hasPendingTree && Number(remainingMs) > 0
}
