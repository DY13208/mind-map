const fs = require('node:fs')
const path = require('node:path')
function verifyDockerFrontendPaths(directory) {
  const root = path.resolve(directory)
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  const assets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map(match => match[1]).filter(value => !/^(?:https?:|data:|#)/i.test(value))
  if (!assets.length) throw new Error('Frontend HTML has no local assets')
  for (const asset of assets) {
    if (!asset.startsWith('/') || asset.startsWith('//'))
      throw new Error(`Docker frontend requires PUBLIC_PATH=/; invalid asset: ${asset}`)
    const filename = path.resolve(root, new URL(asset, 'http://build.local').pathname.slice(1))
    const relative = path.relative(root, filename)
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(filename).isFile())
      throw new Error('Missing frontend asset: ' + asset)
  }
  return assets
}
module.exports = { verifyDockerFrontendPaths }
if (require.main === module) {
  try {
    const assets = verifyDockerFrontendPaths(process.argv[2])
    console.log(`PASS: Docker root paths and ${assets.length} referenced assets verified`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
