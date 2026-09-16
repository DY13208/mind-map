import PQueue from 'p-queue'

function resolveConcurrency() {
  const runtime =
    (typeof window !== 'undefined' && window.__MIND_MAP_RUNTIME__) || {}
  const n = Number(runtime.attachmentUploadConcurrency)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2
}

export const attachmentUploadQueue = new PQueue({
  concurrency: resolveConcurrency()
})

export function enqueueAttachmentUpload(task) {
  return attachmentUploadQueue.add(task)
}

export function attachmentQueuePending() {
  return attachmentUploadQueue.pending
}

export function attachmentQueueSize() {
  return attachmentUploadQueue.size
}
