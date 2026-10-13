import MindMap from 'simple-mind-map'
import ExportPDF from 'simple-mind-map/src/plugins/ExportPDF.js'
import ExportXMind from 'simple-mind-map/src/plugins/ExportXMind.js'
import Export from 'simple-mind-map/src/plugins/Export.js'
import RichText from 'simple-mind-map/src/plugins/RichText.js'
import Formula from 'simple-mind-map/src/plugins/Formula.js'
import AssociativeLine from 'simple-mind-map/src/plugins/AssociativeLine.js'
import OuterFrame from 'simple-mind-map/src/plugins/OuterFrame.js'
import NodeBase64ImageStorage from 'simple-mind-map/src/plugins/NodeBase64ImageStorage.js'
import RainbowLines from 'simple-mind-map/src/plugins/RainbowLines.js'
import MindMapLayoutPro from 'simple-mind-map/src/plugins/MindMapLayoutPro.js'
import Themes from 'simple-mind-map-plugin-themes'
import { downloadFile, imgToDataUrl } from 'simple-mind-map/src/utils/index'
import { ERROR_TYPES } from 'simple-mind-map/src/constants/constant'

export const HISTORY_EXPORT_TYPES = Object.freeze([
  'smm',
  'png',
  'pdf',
  'svg',
  'md',
  'xmind',
  'txt',
  'json'
])

const PLUGINS = [
  NodeBase64ImageStorage,
  // The editor registers RichText with options through addPlugin. A local
  // subclass gives this temporary instance the same default options without
  // mutating the shared plugin constructor used by normal editors.
  class HistoryExportRichText extends RichText {},
  Formula,
  AssociativeLine,
  OuterFrame,
  RainbowLines,
  MindMapLayoutPro,
  ExportPDF,
  ExportXMind,
  Export
]
PLUGINS[1].instanceName = RichText.instanceName
PLUGINS[1].pluginOpt = {}

const RENDER_TIMEOUT_MS = 60000
const EXPORT_TIMEOUT_MS = 60000
const BACKGROUND_IMAGE_TIMEOUT_MS = 15000
let themesRegistered = false

function cloneJson(value) {
  if (value == null) return value
  return JSON.parse(JSON.stringify(value))
}

function throwIfAborted(signal) {
  if (!signal || !signal.aborted) return
  const error = new Error('历史版本导出已取消')
  error.name = 'AbortError'
  throw error
}

function waitForTaskOrAbort(task, signal) {
  if (signal && signal.aborted) {
    Promise.resolve(task).catch(() => {})
    const error = new Error('历史版本导出已取消')
    error.name = 'AbortError'
    return Promise.reject(error)
  }
  return new Promise((resolve, reject) => {
    let timeout
    const cleanup = () => {
      clearTimeout(timeout)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      const error = new Error('历史版本导出已取消')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    timeout = setTimeout(() => {
      cleanup()
      reject(new Error('历史版本导出资源加载超时，请重试'))
    }, EXPORT_TIMEOUT_MS)
    // Attach both handlers immediately. If abort wins, a later export failure
    // is still observed and cannot become an unhandled rejection.
    Promise.resolve(task).then(
      value => {
        cleanup()
        resolve(value)
      },
      error => {
        cleanup()
        reject(error)
      }
    )
  })
}

function normalizeMetadata(metadata = {}) {
  const rawTheme = metadata.theme
  const theme =
    typeof rawTheme === 'string'
      ? rawTheme
      : rawTheme && (rawTheme.template || rawTheme.name || rawTheme.theme)
  const themeConfig =
    metadata.themeConfig ||
    (rawTheme && typeof rawTheme === 'object'
      ? rawTheme.config || rawTheme.themeConfig
      : null)

  return {
    layout: metadata.layout || undefined,
    theme: theme || 'default',
    themeConfig: cloneJson(themeConfig || {}),
    viewData: metadata.view ? cloneJson(metadata.view) : undefined
  }
}

function createFooter(extraText) {
  const text = String(extraText || '')
  if (!text.trim()) return null

  const el = document.createElement('div')
  el.className = 'footer'
  el.innerHTML = text
  return {
    el,
    cssText: `
      .footer {
        width: 100%;
        height: 30px;
        display: flex;
        justify-content: center;
        align-items: center;
        font-size: 12px;
        color: #979797;
      }
    `,
    height: 30
  }
}

function createExportHost() {
  const host = document.createElement('div')
  host.className = 'smm-history-export-host'
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText =
    'position:fixed;left:-100000px;top:0;width:1920px;height:1200px;overflow:hidden;pointer-events:none;'
  document.body.appendChild(host)
  return host
}

function ensureThemesRegistered() {
  if (!themesRegistered) {
    // The editor normally initializes these templates. History can be opened
    // from the product shell without mounting the editor first.
    Themes.init(MindMap)
    themesRegistered = true
  }
}

function waitForInitialRender(mindMap, signal, setRenderReject) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timeout = null

    const cleanup = () => {
      clearTimeout(timeout)
      mindMap.off('render_complete', onComplete)
      mindMap.off('render_cancelled', onCancelled)
      if (signal) signal.removeEventListener('abort', onAbort)
      setRenderReject(null)
    }
    const finish = (error = null) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const onComplete = () => finish()
    const onCancelled = () =>
      finish(new Error('历史版本画布渲染未完成，导出已停止'))
    const onAbort = () => {
      const error = new Error('历史版本导出已取消')
      error.name = 'AbortError'
      finish(error)
    }

    setRenderReject(error => finish(error || new Error('历史版本画布布局失败')))
    mindMap.on('render_complete', onComplete)
    mindMap.on('render_cancelled', onCancelled)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    timeout = setTimeout(
      () => finish(new Error('历史版本画布渲染超时，导出已停止')),
      RENDER_TIMEOUT_MS
    )
    if (signal && signal.aborted) onAbort()
  })
}

function exportArguments(request) {
  switch (request.type) {
    case 'smm':
    case 'json':
      return [!!request.withConfig]
    case 'png':
      return [!!request.isTransparent, null, !!request.isFitBg]
    case 'pdf':
      return [!!request.isTransparent, !!request.isFitBg]
    case 'svg':
      return [
        `* {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }`
      ]
    case 'md':
    case 'xmind':
    case 'txt':
      return []
    default:
      throw new Error(`不支持导出格式：${request.type || ''}`)
  }
}

function normalizedPadding(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 10
}

function safeFileName(value) {
  return String(value || '思维导图历史版本')
    .replace(/[\\/:*?"<>|]/g, '_')
    .split('')
    .map(char => (char.charCodeAt(0) < 32 ? '_' : char))
    .join('')
    .trim() || '思维导图历史版本'
}

function getBackgroundImageUrl(value) {
  const source = String(value || '').trim()
  const match = /^url\((.*)\)$/i.exec(source)
  if (!match) return source
  return match[1].trim().replace(/^(['"])(.*)\1$/, '$2')
}

function validateBackgroundImage(value, signal) {
  const source = getBackgroundImageUrl(value)
  if (!source || source === 'none') return Promise.resolve()
  if (signal && signal.aborted) {
    const error = new Error('历史版本导出已取消')
    error.name = 'AbortError'
    return Promise.reject(error)
  }

  return new Promise((resolve, reject) => {
    const image = new Image()
    let settled = false
    let timeout = null
    const cleanup = () => {
      clearTimeout(timeout)
      image.onload = null
      image.onerror = null
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    const finish = error => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const onAbort = () => {
      const error = new Error('历史版本导出已取消')
      error.name = 'AbortError'
      image.removeAttribute('src')
      finish(error)
    }

    image.crossOrigin = 'anonymous'
    image.onload = () => finish()
    image.onerror = () =>
      finish(new Error('历史版本背景图片资源加载失败，未生成导出文件'))
    timeout = setTimeout(
      () =>
        finish(new Error('历史版本背景图片加载超时，未生成导出文件')),
      BACKGROUND_IMAGE_TIMEOUT_MS
    )
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    if (signal && signal.aborted) {
      onAbort()
      return
    }
    image.src = source
  })
}

function makeSvgBackgroundExportRejectOnFailure(mindMap) {
  const exporter = mindMap && mindMap.doExport
  if (!exporter) return
  // simple-mind-map wraps this async body in `new Promise(resolve => ...)`,
  // which leaves the outer Promise pending when the background image rejects.
  // Keep the same output semantics while allowing failures to reach the caller.
  exporter.drawBackgroundToSvg = async svg => {
    const {
      backgroundColor = '#fff',
      backgroundImage,
      backgroundRepeat = 'repeat'
    } = mindMap.themeConfig
    svg.css('background-color', backgroundColor)
    if (backgroundImage && backgroundImage !== 'none') {
      let imageDataUrl
      try {
        imageDataUrl = await imgToDataUrl(getBackgroundImageUrl(backgroundImage))
      } catch (error) {
        const failure = new Error(
          '历史版本背景图片资源加载失败，未生成导出文件'
        )
        failure.cause = error
        throw failure
      }
      svg.css('background-image', `url(${imageDataUrl})`)
      svg.css('background-repeat', backgroundRepeat)
    }
  }
}

function restoreUnregisteredFormulaPlugin(instance) {
  if (!instance || MindMap.hasPlugin(Formula) !== -1) return

  // Formula's destroy hook keeps its Quill registration while another map is
  // alive. A history export is instance-local, so when Formula is not globally
  // registered its temporary registration must be reverted even if the user
  // has the ordinary editor open at the same time.
  if (typeof instance.onDestroy === 'function') instance.onDestroy()
}

/**
 * Export one immutable historical snapshot with an isolated MindMap instance.
 * `tree` must be the complete, independent node tree supplied by the caller.
 */
export async function exportHistoryVersion({
  tree,
  metadata = {},
  request = {},
  signal
} = {}) {
  throwIfAborted(signal)
  if (!HISTORY_EXPORT_TYPES.includes(request.type)) {
    throw new Error(`不支持导出格式：${request.type || ''}`)
  }
  const sourceTree = tree && tree.root && tree.root.data ? tree.root : tree
  if (!sourceTree || !sourceTree.data || !Array.isArray(sourceTree.children)) {
    throw new Error('历史版本数据不完整，无法导出')
  }
  if (typeof document === 'undefined' || !document.body) {
    throw new Error('当前环境无法创建历史版本导出画布')
  }

  ensureThemesRegistered()
  const mapMetadata = normalizeMetadata(metadata)
  const fileName = safeFileName(request.fileName)
  const footer = createFooter(request.extraText)
  let exportLoadError = null
  let renderReject = null
  let host = null
  let mindMap = null

  try {
    throwIfAborted(signal)
    host = createExportHost()
    mindMap = new MindMap({
      el: host,
      // MindMap.handleData takes its own copy. The caller owns this history
      // snapshot and it remains untouched throughout export.
      data: sourceTree,
      layout: mapMetadata.layout,
      theme: mapMetadata.theme,
      themeConfig: mapMetadata.themeConfig,
      viewData: mapMetadata.viewData,
      fit: false,
      initPlugins: false,
      readonly: true,
      historyInteractionPaused: true,
      customCheckEnableShortcut: () => false,
      exportPaddingX: normalizedPadding(request.paddingX),
      exportPaddingY: normalizedPadding(request.paddingY),
      addContentToFooter: () => footer,
      errorHandler: (code, error) => {
        if (code === ERROR_TYPES.EXPORT_LOAD_IMAGE_ERROR) {
          exportLoadError = error || new Error('历史版本图片资源加载失败')
        } else if (code === 'layout_error' && renderReject) {
          renderReject(error)
        }
      }
    })

    // Disable core shortcuts and readonly writes. No Cooperate, keyboard,
    // drag, selection, or paste plugin is initialized for this temporary map.
    if (mindMap.keyCommand) {
      mindMap.keyCommand.pause()
      mindMap.keyCommand.shortcutMap = Object.create(null)
    }
    // initPlugin is instance-local; unlike addPlugin/usePlugin it does not
    // alter MindMap.pluginList or change which plugins future editors load.
    PLUGINS.forEach(plugin => mindMap.initPlugin(plugin))
    makeSvgBackgroundExportRejectOnFailure(mindMap)
    const renderPromise = waitForInitialRender(mindMap, signal, callback => {
      renderReject = callback
    })
    await renderPromise
    throwIfAborted(signal)
    const backgroundImage = mindMap.themeConfig.backgroundImage
    if (
      ['png', 'pdf'].includes(request.type) &&
      request.isFitBg &&
      !request.isTransparent
    ) {
      await validateBackgroundImage(backgroundImage, signal)
    }

    const exportTask = Promise.resolve().then(() =>
      mindMap.doExport.export(
        request.type,
        false,
        fileName,
        ...exportArguments(request)
      )
    )
    const result = await waitForTaskOrAbort(exportTask, signal)
    throwIfAborted(signal)
    if (exportLoadError) {
      const error = new Error('历史版本中的图片资源加载失败，未生成导出文件')
      error.cause = exportLoadError
      throw error
    }
    if (result == null || result === '') {
      throw new Error('历史版本导出没有生成文件')
    }

    downloadFile(result, `${fileName}.${request.type}`)
    return { type: request.type, fileName: `${fileName}.${request.type}` }
  } finally {
    try {
      if (mindMap) {
        const formulaInstance = mindMap.formula
        PLUGINS.forEach(plugin => {
          const pluginInstance = plugin.instanceName && mindMap[plugin.instanceName]
          if (!pluginInstance) return
          if (typeof pluginInstance.beforePluginDestroy === 'function') {
            pluginInstance.beforePluginDestroy()
          }
          mindMap[plugin.instanceName] = null
        })
        if (
          mindMap.renderer &&
          typeof mindMap.renderer.cancelRender === 'function'
        ) {
          mindMap.renderer.cancelRender()
        }
        mindMap.destroy()
        restoreUnregisteredFormulaPlugin(formulaInstance)
      }
    } finally {
      if (host && host.parentNode) host.parentNode.removeChild(host)
    }
  }
}

export default exportHistoryVersion
