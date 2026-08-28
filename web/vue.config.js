const path = require('path')
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
  transpileDependencies: ['yjs', 'lib0', 'quill', 'y-websocket', 'y-protocols'],
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
        yjs: path.resolve(__dirname, './node_modules/yjs')
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
      }
    }
  }
}
