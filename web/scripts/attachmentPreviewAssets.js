const fs = require('fs')
const path = require('path')
const esbuild = require('esbuild')

// Build self-hosted workers so previewing private files never needs a CDN.
module.exports = function prepareAttachmentPreviewAssets() {
  const root = path.resolve(__dirname, '..')
  const dest = path.resolve(root, '../.tmp/attachment-preview-assets')
  const pdf = path.dirname(require.resolve('pdfjs-dist/package.json'))
  fs.mkdirSync(dest, { recursive: true })
  for (const folder of ['cmaps', 'standard_fonts', 'wasm']) {
    if (fs.existsSync(path.join(pdf, folder))) {
      fs.cpSync(path.join(pdf, folder), path.join(dest, 'pdf', folder), { recursive: true })
    }
  }
  fs.mkdirSync(path.join(dest, 'pdf'), { recursive: true })
  // .js also works for native ES modules and uses existing Nginx MIME rules.
  for (const file of ['pdf', 'pdf.worker']) {
    fs.copyFileSync(path.join(pdf, 'legacy/build', file + '.mjs'), path.join(dest, 'pdf', file + '.js'))
    fs.rmSync(path.join(dest, 'pdf', file + '.mjs'), { force: true })
  }
  fs.copyFileSync(path.join(pdf, 'LICENSE'), path.join(dest, 'pdf', 'LICENSE'))
  esbuild.buildSync({
    entryPoints: [path.join(root, 'src/workers/attachmentWorkbook.worker.js')],
    bundle: true, platform: 'browser', format: 'iife', target: 'es2018',
    outfile: path.join(dest, 'workbook.worker.js'), minify: true,
    alias: { 'simple-mind-map': path.resolve(root, '../simple-mind-map') },
    nodePaths: [path.join(root, 'node_modules')]
  })
  return dest
}
