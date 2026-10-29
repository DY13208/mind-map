const { execSync } = require('child_process')

function show(rev, file) {
  return execSync(`git show ${rev}:${file}`, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  })
}

function quoted(src) {
  const arr = src.split('\n')
  const i = arr.findIndex(l => l.includes('instructions:'))
  const j = arr.findIndex((l, idx) => idx > i && l.trim() === '}')
  return arr.slice(i + 1, j).map(l => {
    let s = l.trim()
    if (s.endsWith('+')) s = s.slice(0, -1).trim()
    if (s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1)
    return s
  })
}

const file = 'simple-mind-map/bin/mcpServer.mjs'
const ours = quoted(show('225a5215', file))
const theirs = quoted(show('48c5b87e', file))
const base = quoted(show('e7412515', file))

function diffStr(a, b, label) {
  if (a === b) {
    console.log(label, 'IDENTICAL', a.length)
    return
  }
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  let j = 0
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++
  console.log('\n', label, 'ours', a.length, 'theirs', b.length, 'commonPrefix', i, 'commonSuffix', j)
  console.log('OURS MID:', JSON.stringify(a.slice(i, a.length - j)))
  console.log('THEIRS MID:', JSON.stringify(b.slice(i, b.length - j)))
}

console.log('base parts', base.length, 'ours', ours.length, 'theirs', theirs.length)
diffStr(ours[1], theirs[0], 'sop sentence')
diffStr(ours[2], theirs[2], 'long paragraph ours[2] vs theirs[2]')
diffStr(base[1], ours[2], 'base long vs ours long')
diffStr(base[1], theirs[2], 'base long vs theirs long')

const vue = 'web/src/pages/Edit/components/Contextmenu.vue'
function extractFn(src, name) {
  const start = src.indexOf(name + '()')
  if (start < 0) return 'MISSING ' + name
  return src.slice(start, start + 1800)
}
for (const rev of ['e7412515', '225a5215', '48c5b87e']) {
  const src = show(rev, vue)
  console.log('\n########', rev, 'copyNodeForAi')
  console.log(extractFn(src, 'async copyNodeForAi').slice(0, 900))
}
