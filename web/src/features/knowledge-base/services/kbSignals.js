// 页面间的轻量信号（keep-alive 下各 tab 不会自动重载）。
// 表头映射重新结构化完成后标记，结构化数据页重新激活时据此重新拉取字段和记录。
const stamps = {}
export function markStructureChanged(fileId) {
  if (fileId) stamps[fileId] = (stamps[fileId] || 0) + 1
}
export function structureStamp(fileId) {
  return stamps[fileId] || 0
}

// 本地上传队列（仅存在于当前页面内存）里尚未提交到后端的文件数，供离开 /kb 路由前确认
let uploadBusy = () => 0
export function registerUploadBusy(fn) {
  uploadBusy = fn
  return () => { if (uploadBusy === fn) uploadBusy = () => 0 }
}
export function pendingUploads() {
  try { return Number(uploadBusy()) || 0 } catch (_) { return 0 }
}
