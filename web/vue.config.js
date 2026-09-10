const path = require('path')
const { execSync } = require('child_process')
try {
  process.env.VUE_APP_BUILD_COMMIT = execSync('git rev-parse --short HEAD', {
    cwd: path.resolve(__dirname, '..')
  })
    .toString()
    .trim()
} catch (err) {
  process.env.VUE_APP_BUILD_COMMIT = process.env.VUE_APP_BUILD_COMMIT || 'unknown'
}
process.env.VUE_APP_BUILD_TIME = new Date().toISOString()
const isDev = process.env.NODE_ENV === 'development'
const isLibrary = process.env.NODE_ENV === 'library'
const publicPath =
  process.env.PUBLIC_PATH !== undefined
    ? process.env.PUBLIC_PATH
    : isDev
    ? ''
    : './dist'

module.exports = {
  publicPath,
  outputDir: '../dist',
  lintOnSave: false,
  productionSourceMap: false,
  filenameHashing: false,
    transpileDependencies: ['yjs', 'lib0', 'quill', 'y-websocket', 'y-protocols', 'socket.io-client', 'engine.io-client'],
  chainWebpack: config => {
    // 移除 preload 插件
    config.plugins.delete('preload')
    // 移除 prefetch 插件
    config.plugins.delete('prefetch')
    // 运行时 publicPath：只替换 webpack 的 `.p = "..."`，避免误伤 chunk 内其它 `"/"`
    // （旧版 webpack-dynamic-public-path 会把 markdown-it 实体 "sol":"/"、vue-i18n 命名空间分隔符等换成 window.externalPublicPath）
    if (!isDev && publicPath) {
      const needle = JSON.stringify(String(publicPath))
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const assignRe = new RegExp('(\\.p\\s*=\\s*)' + escaped)
      config.plugin('safe-dynamic-public-path').use(
        class SafeDynamicPublicPathPlugin {
          apply(compiler) {
            compiler.hooks.emit.tapAsync(
              'SafeDynamicPublicPathPlugin',
              (compilation, callback) => {
                Object.keys(compilation.assets).forEach(name => {
                  if (!/\.js$/i.test(name)) return
                  const asset = compilation.assets[name]
                  const raw = asset.source()
                  const source = Buffer.isBuffer(raw)
                    ? raw.toString('utf8')
                    : raw
                  if (typeof source !== 'string' || !assignRe.test(source)) {
                    return
                  }
                  const next = source.replace(
                    assignRe,
                    '$1window.externalPublicPath'
                  )
                  compilation.assets[name] = {
                    source: () => next,
                    size: () => Buffer.byteLength(next, 'utf8')
                  }
                })
                callback()
              }
            )
          }
        }
      )
    }
    // 给插入html页面内的js和css添加hash参数
    if (!isLibrary) {
      config.plugin('html').tap(args => {
        args[0].hash = true
        return args
      })
    }
  },
  configureWebpack: {
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src/'),
        // 使用仓库内源码，避免 node_modules 旧版 Cooperate 在刷新时 initData 死循环
        'simple-mind-map': path.resolve(__dirname, '../simple-mind-map'),
        yjs: path.resolve(__dirname, './node_modules/yjs'),
        'y-webrtc': path.resolve(__dirname, './node_modules/y-webrtc'),
        'y-websocket': path.resolve(__dirname, './node_modules/y-websocket')
      }
    }
  },
  devServer: {
    host: '0.0.0.0',
    port: 8081,
    disableHostCheck: true,
    historyApiFallback: true,
    proxy: {
      '^/api/v3/': {
        target: 'http://ark.cn-beijing.volces.com',
        changeOrigin: true
      },
      '/wb-api': {
        target: process.env.WORKBUDDY_API || 'http://127.0.0.1:3000',
        changeOrigin: true,
        pathRewrite: { '^/wb-api': '' },
        timeout: 0,
        proxyTimeout: 3600000
      },
      '/openclaw-api': {
        target: process.env.OPENCLAW_API || 'http://127.0.0.1:18789',
        changeOrigin: true,
        pathRewrite: { '^/openclaw-api': '' },
        timeout: 0,
        proxyTimeout: 3600000,
        ws: true
      },
      '/openclaw-bridge': {
        target: process.env.OPENCLAW_BRIDGE || 'http://127.0.0.1:18790',
        changeOrigin: true,
        pathRewrite: { '^/openclaw-bridge': '' },
        timeout: 0,
        proxyTimeout: 3600000,
        ws: true
      },
      '/collab-v2': {
        target: process.env.COLLAB_API || 'http://127.0.0.1:1234',
        changeOrigin: true,
        ws: true
      },
      '/api': {
        target: process.env.COLLAB_API || 'http://127.0.0.1:1234',
        changeOrigin: true,
        ws: true
      }
    }
  }
}
