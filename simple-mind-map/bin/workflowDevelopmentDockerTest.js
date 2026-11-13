const { spawn } = require('node:child_process')

const [image, ...command] = process.argv.slice(2)
if (!image || !command.length || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]+$/.test(image)) {
  console.error('Usage: workflowDevelopmentDockerTest.js IMAGE COMMAND [ARGS...]')
  process.exitCode = 2
} else {
  const child = spawn('docker', [
    'run', '--rm', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
    '--mount', `type=bind,source=${process.cwd()},target=/workspace,readonly`,
    '--workdir', '/workspace', image, ...command
  ], { stdio: 'inherit', windowsHide: true })
  child.once('error', error => {
    console.error('Could not start Docker test runner:', error.code)
    process.exitCode = 1
  })
  child.once('close', code => { process.exitCode = code ?? 1 })
}
