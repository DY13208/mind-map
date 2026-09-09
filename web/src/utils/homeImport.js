/**
 * 首页导入：单文件新建脑图，或多画布 XMind 批量导入到文件夹
 */
import JSZip from 'jszip'
import xmind from 'simple-mind-map/src/parse/xmind.js'
import markdown from 'simple-mind-map/src/parse/markdown.js'
import {
  parseJsonOffMainThread,
  prepareImportedTree,
  yieldToUi
} from '@/utils/importTree'
import { replaceFileTree } from '@/utils/fileApi'
import roomService from '@/services/roomService'
import folderService from '@/services/folderService'
import teamService from '@/services/teamService'

const NAME_RE = /\.(smm|json|xmind|md)$/i

export function isSupportedImportName(name) {
  return NAME_RE.test(String(name || ''))
}

export function importFileKind(name) {
  const m = NAME_RE.exec(String(name || ''))
  return m ? String(m[1]).toLowerCase() : ''
}

function stripExt(name) {
  return String(name || '')
    .replace(/\.[^.]+$/, '')
    .trim()
    .slice(0, 60)
}

function safeTitle(title, fallback = '未命名脑图') {
  const t = String(title || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return t || fallback
}

function toReplaceTree(parsed) {
  const prepared = prepareImportedTree(parsed)
  const data = prepared && prepared.data
  return (data && data.root) || data
}

async function createRoomInContext({ title, folderId, teamId }) {
  if (teamId) {
    return teamService.createRoom(teamId, title, folderId || null)
  }
  return roomService.createRoom(title, folderId || null)
}

/**
 * 列出 XMind 全部画布标题（不解析节点树）
 */
export async function listXmindSheets(file) {
  const zip = await JSZip.loadAsync(file)
  const jsonFile = zip.files['content.json']
  if (!jsonFile) {
    return [{ index: 0, title: '画布 1' }]
  }
  const content = JSON.parse(await jsonFile.async('string'))
  if (!Array.isArray(content) || !content.length) {
    return [{ index: 0, title: '画布 1' }]
  }
  return content.map((sheet, index) => ({
    index,
    title: safeTitle(sheet && sheet.title, `画布 ${index + 1}`)
  }))
}

/**
 * 解析指定下标的 XMind 画布为导图数据
 */
export async function parseXmindSheet(file, index = 0) {
  return xmind.parseXmindFile(file, async content => {
    if (!Array.isArray(content) || !content.length) return null
    return content[index] || content[0]
  })
}

export async function parseImportFile(file, options = {}) {
  const kind = importFileKind(file && file.name)
  if (!kind) throw new Error('仅支持 .smm / .json / .xmind / .md')

  if (kind === 'smm' || kind === 'json') {
    const text = await readAsText(file)
    const data = await parseJsonOffMainThread(text)
    if (!data || typeof data !== 'object') {
      throw new Error('文件内容不是有效的 JSON 脑图')
    }
    return {
      kind,
      title: safeTitle(options.title || stripExt(file.name)),
      sheets: [{ index: 0, title: safeTitle(options.title || stripExt(file.name)), data }]
    }
  }

  if (kind === 'md') {
    const text = await readAsText(file)
    const data = markdown.transformMarkdownTo(text)
    return {
      kind,
      title: safeTitle(options.title || stripExt(file.name)),
      sheets: [{ index: 0, title: safeTitle(options.title || stripExt(file.name)), data }]
    }
  }

  // xmind
  const sheetMetas = await listXmindSheets(file)
  const indexes =
    Array.isArray(options.sheetIndexes) && options.sheetIndexes.length
      ? options.sheetIndexes
      : sheetMetas.map(s => s.index)
  const sheets = []
  for (const index of indexes) {
    await yieldToUi()
    const meta = sheetMetas.find(s => s.index === index) || {
      index,
      title: `画布 ${index + 1}`
    }
    const data = await parseXmindSheet(file, index)
    sheets.push({
      index,
      title: safeTitle(meta.title, `画布 ${index + 1}`),
      data
    })
  }
  return {
    kind: 'xmind',
    title: safeTitle(options.title || stripExt(file.name)),
    sheets,
    allSheets: sheetMetas
  }
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsText(file)
  })
}

/**
 * 导入为单张脑图（当前文件夹 / 根目录）
 */
export async function importAsSingleRoom({
  file,
  folderId = null,
  teamId = null,
  title,
  sheetIndex = 0,
  onProgress
} = {}) {
  const report = (msg, pct) => onProgress && onProgress({ message: msg, percent: pct })
  report('解析文件…', 10)
  await yieldToUi()
  const parsed = await parseImportFile(file, {
    title,
    sheetIndexes: [sheetIndex]
  })
  const sheet = parsed.sheets[0]
  if (!sheet || !sheet.data) throw new Error('未能解析出脑图数据')
  const roomTitle = safeTitle(title || sheet.title || parsed.title)
  report(`创建脑图「${roomTitle}」…`, 40)
  const room = await createRoomInContext({
    title: roomTitle,
    folderId,
    teamId
  })
  const tree = toReplaceTree(sheet.data)
  if (!tree) throw new Error('脑图树为空')
  report('写入内容…', 70)
  await replaceFileTree(room.roomKey, tree, {
    title: roomTitle,
    source: 'home-import'
  })
  report('完成', 100)
  return { room, title: roomTitle, sheetCount: 1 }
}

/**
 * 多画布批量导入：新建文件夹，每个画布一张脑图
 */
export async function importXmindCanvasesToFolder({
  file,
  folderName,
  sheetIndexes,
  teamId = null,
  onProgress
} = {}) {
  const report = (msg, pct, extra = {}) =>
    onProgress && onProgress({ message: msg, percent: pct, ...extra })

  if (teamId) {
    throw new Error('团队空间暂不支持批量导入到文件夹，请先切回个人空间')
  }

  report('读取画布列表…', 5)
  const metas = await listXmindSheets(file)
  if (metas.length < 2) {
    throw new Error('该文件只有一个画布，请使用「导入为单张脑图」')
  }
  const indexes =
    Array.isArray(sheetIndexes) && sheetIndexes.length
      ? sheetIndexes
      : metas.map(s => s.index)
  const selected = metas.filter(m => indexes.includes(m.index))
  if (!selected.length) throw new Error('请至少选择一个画布')

  const name = safeTitle(folderName || stripExt(file.name), '导入文件夹')
  report(`创建文件夹「${name}」…`, 10)
  const folder = await folderService.createFolder(name)
  const folderId = folder && (folder.id || folder.folderId)
  if (!folderId) throw new Error('文件夹创建失败')

  const created = []
  const failed = []
  for (let i = 0; i < selected.length; i++) {
    const meta = selected[i]
    const pct = 15 + Math.round(((i + 1) / selected.length) * 80)
    report(`导入画布 ${i + 1}/${selected.length}：「${meta.title}」…`, pct, {
      current: i + 1,
      total: selected.length
    })
    await yieldToUi()
    try {
      const data = await parseXmindSheet(file, meta.index)
      const room = await createRoomInContext({
        title: meta.title,
        folderId,
        teamId: null
      })
      const tree = toReplaceTree(data)
      if (!tree) throw new Error('脑图树为空')
      await replaceFileTree(room.roomKey, tree, {
        title: meta.title,
        source: 'home-import-batch'
      })
      created.push({ room, title: meta.title })
    } catch (err) {
      failed.push({
        title: meta.title,
        message: (err && err.message) || String(err)
      })
    }
  }

  report(
    failed.length
      ? `完成：成功 ${created.length}，失败 ${failed.length}`
      : `完成：已导入 ${created.length} 个画布`,
    100,
    { current: selected.length, total: selected.length }
  )

  return {
    folder,
    folderId,
    folderName: name,
    created,
    failed,
    sheetCount: selected.length
  }
}
