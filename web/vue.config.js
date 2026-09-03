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

const WebpackDynamicPublicPathPlugin = require('webpack-dynamic-public-path')

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
    // 支持运行时设置public path
    if (!isDev) {
      config
        .plugin('dynamicPublicPathPlugin')
        .use(WebpackDynamicPublicPathPlugin, [
          { externalPublicPath: 'window.externalPublicPath' }
        ])
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
