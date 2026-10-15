const { execFileSync } = require('node:child_process')

function deadline(promise, ms) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned fixture cleanup deadline')), ms) })])
    .finally(() => clearTimeout(timer))
}
function ownedChromeProcesses() {
  const table = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).trim().split('\n').map(row => {
    const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    return match && { pid: Number(match[1]), parent: Number(match[2]), command: match[3] }
  }).filter(Boolean)
  const roots = table.filter(row => row.parent === process.pid && row.command.includes('Google Chrome.app/Contents/MacOS/Google Chrome'))
  const owned = new Set(roots.map(row => row.pid))
  for (let changed = true; changed;) {
    changed = false
    for (const row of table) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true }
  }
  return [...owned]
}

async function closeOwnedFixture(browser, clients, fixture) {
  // Capture the exact current runner's Chrome descendants while still owned;
  // never match every browser/user process by its name.
  const chrome = ownedChromeProcesses()
  const warnings = []
  const forcedOwnedChrome = []
  try {
    for (const client of clients) await deadline(client.context.close(), 5000).catch(error => warnings.push(error.message))
    if (browser) await deadline(browser.close(), 10000).catch(error => warnings.push(error.message))
    const stillOwned = new Set(ownedChromeProcesses())
    if (warnings.length) for (const pid of chrome.filter(pid => stillOwned.has(pid))) {
      try { process.kill(pid, 'SIGTERM'); forcedOwnedChrome.push(pid) } catch (error) { if (error.code !== 'ESRCH') warnings.push(error.message) }
    }
  } finally {
    await deadline(fixture.close(), 60000)
  }
  return { warnings, forcedOwnedChrome }
}
module.exports = { closeOwnedFixture }
