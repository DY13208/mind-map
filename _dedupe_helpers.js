const fs = require('fs');
const p = 'integrations/openclaw/phase4/run_final_gate.js';
let s = fs.readFileSync(p, 'utf8');
function removeSecondFn(src, sig) {
  const first = src.indexOf(sig);
  if (first < 0) throw new Error('missing ' + sig);
  const second = src.indexOf(sig, first + sig.length);
  if (second < 0) return src;
  let i = src.indexOf('{', second);
  let d = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') {
      d--;
      if (d === 0) { i++; break; }
    }
  }
  while (src[i] === '\n' || src[i] === '\r') i++;
  console.log('removing second', sig, 'at', second, 'to', i);
  return src.slice(0, second) + src.slice(i);
}
for (const sig of [
  'function shEnv(',
  'function shAllowEnv(',
  'async function waitHealth(',
  'async function waitReady(',
  'async function callTool(',
]) {
  s = removeSecondFn(s, sig);
}
fs.writeFileSync(p, s);
require('child_process').execSync('node --check "' + p + '"', { stdio: 'inherit' });
const s2 = fs.readFileSync(p, 'utf8');
for (const n of ['function shEnv(', 'async function waitHealth(', 'async function callTool(', 'function httpJson(']) {
  console.log(n, s2.split(n).length - 1);
}
console.log('size', s2.length);
