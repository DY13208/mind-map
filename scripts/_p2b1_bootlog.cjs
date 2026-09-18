const { spawn, execSync } = require('child_process')
const fs = require('fs')
function sleep(ms){ Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms) }
try { execSync('docker compose up -d openclaw-gateway', {cwd:'D:\\mind-map', stdio:'inherit'}) } catch {}
sleep(1500)
const id = execSync('docker ps -aq --filter name=mind-map-openclaw-gateway-1', {encoding:'utf8'}).trim().split(/\n/)[0]
console.log('id', id)
if (!id) { console.log('no container'); process.exit(1) }
const log = spawn('docker', ['logs', '-f', id], {stdio:['ignore','pipe','pipe']})
let buf = ''
log.stdout.on('data', d => { buf += d; process.stdout.write(d) })
log.stderr.on('data', d => { buf += d; process.stderr.write(d) })
sleep(12000)
log.kill()
fs.writeFileSync('D:\\mind-map\\.tmp\\gw-boot.log', buf)
console.log('\\n---STATUS---')
try { console.log(execSync('docker ps -a --filter name=openclaw-gateway --format "{{.Names}} {{.Status}}"',{encoding:'utf8'})) } catch(e){ console.log(e.message) }
console.log('---INSPECT EXIT---')
try { console.log(execSync(`docker inspect ${id} --format "{{.State.Status}} {{.State.ExitCode}} {{.State.Error}} {{.State.OOMKilled}}"`,{encoding:'utf8'})) } catch(e){ console.log(e.message) }
