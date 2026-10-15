"use strict"
// Attempt every owned shutdown step, while preserving the original failure.
async function cleanupAll(tasks) {
  let firstError
  for (const task of tasks) {
    try { await task() } catch (error) { if (!firstError) firstError = error }
  }
  if (firstError) throw firstError
}
module.exports = { cleanupAll }
