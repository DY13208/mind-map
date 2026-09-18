const fs = require('fs');
const s = fs.readFileSync('integrations/openclaw/phase4/run_final_gate.js', 'utf8');
const lines = s.split('\n');
let d = 0, started = false, mainStart = -1, mainEnd = -1;
for (let n = 0; n < lines.length; n++) {
  if (lines[n].includes('async function main')) { started = true; mainStart = n + 1; }
  if (!started) continue;
  for (const ch of lines[n]) {
    if (ch === '{') d++;
    if (ch === '}') {
      d--;
      if (d === 0) { mainEnd = n + 1; started = false; break; }
    }
  }
  if (mainEnd > 0 && !started) break;
}
console.log({ len: s.length, mainStart, mainEnd });
console.log('--- near main end ---');
for (let n = Math.max(0, mainEnd - 10); n < Math.min(lines.length, mainEnd + 6); n++) {
  console.log(String(n + 1).padStart(4) + ':' + lines[n]);
}
const g1line = lines.findIndex((l) => l.includes('await gate(1')) + 1;
const g12line = lines.findIndex((l) => l.includes('await gate(12')) + 1;
console.log({ g1line, g12line, gatesInsideMain: g1line > mainStart && g1line < mainEnd && g12line < mainEnd });
console.log('main().catch', /main\(\)\s*\.catch/.test(s));
console.log('process.exit in main?', s.slice(s.indexOf('async function main'), s.indexOf('async function main') + 5000).includes('process.exit'));