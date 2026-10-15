const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const repo = path.resolve(__dirname, '../..')
const esbuild = require(path.join(repo, 'web/node_modules/esbuild'))
const compiler = require(path.join(repo, 'web/node_modules/vue-template-compiler'))
const babel = require(path.join(repo, 'web/node_modules/@babel/core'))
const { chromium } = require(path.join(repo, 'simple-mind-map/node_modules/@playwright/test'))

function resolveSource(candidate) {
  for (const filename of [candidate, `${candidate}.js`, `${candidate}.vue`, `${candidate}.json`, path.join(candidate, 'index.js')]) {
    if (fs.existsSync(filename) && fs.statSync(filename).isFile()) return filename
  }
  return candidate
}

function sfcPlugin(stubs = {}, sourceRoot = repo) {
  return {
    name: 'real-vue-sfc-fixture',
    setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        const absolute = args.path.startsWith('.') ? resolveSource(path.resolve(args.resolveDir, args.path)) : args.path
        const replacement = stubs[absolute] ?? stubs[args.path]
        if (replacement != null) return { path: absolute, namespace: 'fixture-boundary', pluginData: replacement }
        if (sourceRoot !== repo && typeof absolute === 'string' &&
          (absolute.startsWith(path.join(repo, 'web/src') + path.sep) ||
           absolute === path.join(repo, 'web/src/store.js') ||
           absolute.startsWith(path.join(repo, 'simple-mind-map') + path.sep)) && !absolute.includes('/node_modules/')) {
          return { path: resolveSource(path.join(sourceRoot, path.relative(repo, absolute))) }
        }
        if (args.path === 'vue' || args.path === 'vue/dist/vue.esm.js') return { path: path.join(repo, 'web/node_modules/vue/dist/vue.esm.js') }
        if (args.path === 'simple-mind-map') return { path: path.join(sourceRoot, 'simple-mind-map/index.js') }
        if (args.path.startsWith('simple-mind-map/')) return { path: resolveSource(path.join(sourceRoot, args.path)) }
        if (args.path.startsWith('@/')) return { path: resolveSource(path.join(sourceRoot, 'web/src', args.path.slice(2))) }
        return null
      })
      // Resolve a stubbed module's own imports from its original directory (so
      // bare packages pick the same copy/ESM entry the real source would);
      // virtual stub ids fall back to the repo root.
      build.onLoad({ filter: /.*/, namespace: 'fixture-boundary' }, args => ({
        contents: args.pluginData, loader: 'js',
        resolveDir: path.isAbsolute(args.path) && fs.existsSync(args.path) ? path.dirname(args.path) : repo
      }))
      build.onLoad({ filter: /\.vue$/ }, args => {
        const source = compiler.parseComponent(fs.readFileSync(args.path, 'utf8'))
        const template = source.template ? source.template.content : '<div></div>'
        const compiled = compiler.compile(template)
        if (compiled.errors.length) throw new Error(`SFC template errors in ${args.path}: ${compiled.errors.join('; ')}`)
        const transformed = babel.transformSync(source.script ? source.script.content : 'export default {}', {
          filename: args.path,
          babelrc: false,
          configFile: false,
          plugins: [({ types: t }) => ({
            visitor: {
              ExportDefaultDeclaration(p) {
                if (p.node._performanceTemplateAssigned) return
                const id = p.scope.generateUidIdentifier('fixtureComponent')
                const componentExport = t.exportDefaultDeclaration(id)
                componentExport._performanceTemplateAssigned = true
                p.replaceWithMultiple([
                  t.variableDeclaration('const', [t.variableDeclarator(id, p.node.declaration)]),
                  t.expressionStatement(t.assignmentExpression('=', t.memberExpression(id, t.identifier('template')), t.stringLiteral(template))),
                  componentExport
                ])
                p.skip()
              }
            }
          })]
        })
        return { contents: transformed.code, loader: 'js', resolveDir: path.dirname(args.path) }
      })
      build.onLoad({ filter: /\.(css|less|scss)$/ }, () => ({ contents: '', loader: 'css' }))
    }
  }
}

async function createHarness(options = {}) {
  const entryOptions = options.contents
    ? { stdin: { contents: options.contents, resolveDir: repo, sourcefile: 'performance-fixture-entry.js' } }
    : { entryPoints: [options.entry] }
  const built = await esbuild.build({
    ...entryOptions,
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    outfile: 'fixture.js',
    nodePaths: [path.join(repo, 'web/node_modules'), path.join(repo, 'simple-mind-map/node_modules')],
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.jpg': 'dataurl', '.jpeg': 'dataurl', '.gif': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
    plugins: [sfcPlugin(options.stubs, options.sourceRoot || repo)],
    define: { 'process.env.NODE_ENV': '"test"' },
    logLevel: 'silent'
  })
  const bundle = built.outputFiles.find(item => item.path.endsWith('.js')).text
  const html = options.html || '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}#map,#mindMapContainer{width:1200px;height:800px}#app{min-height:800px}</style></head><body><div id="app"></div><div id="map"></div><script src="/fixture.js"></script></body></html>'
  const server = http.createServer((req, res) => {
    if (req.url.split('?')[0] === '/fixture.js') {
      res.setHeader('Content-Type', 'application/javascript')
      res.end(bundle)
    } else if (typeof options.handleRequest === 'function' && options.handleRequest(req, res)) {
      return
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(html)
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  let browser
  try {
    const browserChoice = fs.existsSync(chromium.executablePath()) ? {} : { channel: 'chrome' }
    browser = await chromium.launch({ headless: true, ...browserChoice, ...(options.launch || {}) })
    const context = await browser.newContext({ viewport: options.viewport || { width: 1280, height: 900 } })
    const errors = []
    const newPage = async urlPath => {
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(baseUrl + (urlPath || '/'))
      return page
    }
    const page = await newPage(options.urlPath)
    return {
      browser, context, page, baseUrl, errors, newPage,
      bundleHash: crypto.createHash('sha256').update(bundle).digest('hex'), sourceRoot: options.sourceRoot || repo,
      async close() {
        const serverClosed = new Promise(resolve => server.close(resolve))
        server.closeAllConnections()
        // Browser.close owns all of this harness's contexts. Closing a context
        // first can wait on an already disconnected Chrome protocol endpoint.
        if (browser.isConnected()) await browser.close()
        await serverClosed
      }
    }
  } catch (error) {
    if (browser && browser.isConnected()) await browser.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    throw error
  }
}

module.exports = { createHarness, sfcPlugin, resolveSource, repo }
