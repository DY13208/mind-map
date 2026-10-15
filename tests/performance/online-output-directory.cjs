const path = require('node:path')
const repo = path.resolve(__dirname, '../..')

// A fresh run label preserves old source/bundle evidence without changing the
// before/after application choice. No labels may escape the owned work area.
function onlineOutputDirectory(phase, leaf = '', label = process.env.PERF_TDD_ONLINE_RUN_LABEL || '') {
  if (!['before', 'after'].includes(phase)) throw new Error('Invalid online output phase')
  if (label && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(label)) throw new Error('Invalid online run label')
  if (leaf && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,150}$/.test(leaf)) throw new Error('Invalid online output leaf')
  return path.join(repo, 'work/performance-tdd', phase, 'online', 'ordinary-logical', label, leaf)
}

module.exports = { onlineOutputDirectory }
