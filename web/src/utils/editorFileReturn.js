import roomService from '@/services/roomService'
import {
  navigateToFileList,
  normalizeReturnTo,
  readReturnContext
} from './fileNavigation'

/** 列表来源优先；直接链接才读取归属，临时请求失败不得被当作根目录。 */
export async function returnFromEditor(router, route, file, notify) {
  const query = (route && route.query) || {}
  const room = String(query.room || '')
  const hasSource = normalizeReturnTo(query.returnTo) || readReturnContext(route)
  let metadata = file && String(file.roomKey || file.id || '') === room ? file : null
  if (!hasSource && !metadata && room) {
    try {
      metadata = await roomService.getRoomInfo(room)
    } catch (error) {
      const status = error && (error.statusCode || error.status)
      if (status !== 403 && status !== 404) throw error
    }
  }
  // 请求期间用户已经离开或切换脑图时，不再把新页面带回旧目录。
  if (router.currentRoute && router.currentRoute !== route &&
      router.currentRoute.fullPath !== route.fullPath) return false
  await navigateToFileList(router, { route, file: metadata, notify })
  return true
}
