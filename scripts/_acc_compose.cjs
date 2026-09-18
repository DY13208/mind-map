const fs = require('fs')
const yaml = fs.readFileSync('docker-compose.yml','utf8')
const i = yaml.indexOf('openclaw-gateway:')
console.log(yaml.slice(i, i+2200))
