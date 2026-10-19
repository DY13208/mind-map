// 游标栈：stack[i] 为第 i+1 页的起始游标（第 1 页为 null）
export function createCursorState() {
  return { stack: [null], index: 0, nextCursor: null }
}
export function currentCursor(s) { return s.stack[s.index] }
export function goNext(s) {
  if (!s.nextCursor) return false
  s.stack.splice(s.index + 1, s.stack.length, s.nextCursor)
  s.index += 1
  return true
}
export function goPrev(s) {
  if (s.index === 0) return false
  s.index -= 1
  return true
}
export function resetCursor(s) {
  s.stack = [null]
  s.index = 0
  s.nextCursor = null
}
