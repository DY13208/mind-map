const fs=require('fs')
const src=fs.readFileSync('integrations/openclaw/liangce-ingress/index.js','utf8')
console.log(src.slice(0,200))
console.log('---LEN', src.length)
// find issue fields used when verifying
const m=src.match(/payload\.(\w+)/g)
console.log([...new Set(m||[])])
