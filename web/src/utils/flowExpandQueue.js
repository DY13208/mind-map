import { nodeUid } from '@/utils/flowExpandPrompt'
import { runFlowExpandJob, validateFlowExpandNode } from '@/utils/flowExpandRunner'

let jobSeq = 0

function nextJobId() {
  jobSeq += 1
  return `flow-expand-${Date.now()}-${jobSeq}`
}

export function createFlowExpandQueue({ getConcurrency, onChange }) {
  const pending = []
  const running = new Map()
  const controllers = new Map()

  const snapshot = () => {
    let slot = 0
    const runningJobs = Array.from(running.values()).map(job => {
      if (job.state === 'running') {
        slot += 1
        return { ...job, slotIndex: slot }
      }
      return { ...job }
    })
    return {
      pending: pending.map((job, index) => ({
        ...job,
        state: 'queued',
        queueIndex: index + 1
      })),
      running: runningJobs,
      queuedCount: pending.length,
      runningCount: running.size,
      total: pending.length + running.size,
      concurrency: Math.max(1, Number(getConcurrency && getConcurrency()) || 2)
    }
  }

  const emit = () => {
    if (onChange) onChange(snapshot())
  }

  const pump = () => {
    const limit = Math.max(1, Number(getConcurrency && getConcurrency()) || 2)
    while (running.size < limit && pending.length) {
      const job = pending.shift()
      running.set(job.id, job)
      job.state = 'running'
      job.status = '准备中…'
      job.startedAt = Date.now()
      emit()
      if (job.onStart) job.onStart(job)
      runJob(job)
    }
    emit()
  }

  const finishing = new Map()

  const finishJob = (job, result) => {
    controllers.delete(job.id)
    job.state = result && result.error ? 'error' : 'done'
    if (result && result.error) job.error = result.error
    if (result && result.cancelled) {
      running.delete(job.id)
      emit()
      pump()
      return
    }
    if (result && result.error) {
      running.delete(job.id)
      emit()
      pump()
      return
    }
    job.status = job.status || '已完成'
    emit()
    const timer = setTimeout(() => {
      finishing.delete(job.id)
      running.delete(job.id)
      emit()
      pump()
    }, 1200)
    finishing.set(job.id, timer)
  }

  const runJob = async job => {
    const controller =
      typeof AbortController !== 'undefined' ? new AbortController() : null
    if (controller) controllers.set(job.id, controller)
    try {
      const result = await runFlowExpandJob({
        mindMap: job.mindMap,
        node: job.node,
        conversationId: job.id,
        signal: controller && controller.signal,
        onStatus: status => {
          job.status = status
          emit()
        }
      })
      job.status = `已完成 · 代办人：${result.assigneeName}`
      job.result = result
      if (job.onSuccess) job.onSuccess(result)
      finishJob(job, { ok: true })
    } catch (err) {
      if (err && err.name === 'AbortError') {
        job.status = '已取消'
        finishJob(job, { cancelled: true })
        return
      }
      const raw = (err && err.message) || String(err || '')
      const msg =
        (err && err.status >= 500) ||
        /Failed to fetch|NetworkError|ECONNREFUSED|Bad Gateway|<!DOCTYPE html>/i.test(
          raw
        )
          ? '连不上 WorkBuddy，请确认服务器已启动 WorkBuddy 代理'
          : raw || '流程补充失败'
      job.status = msg
      job.error = msg
      if (job.onError) job.onError(err, msg)
      finishJob(job, { error: msg })
    }
  }

  const hasNode = uid => {
    if (!uid) return false
    if (pending.some(job => job.nodeUid === uid)) return true
    return Array.from(running.values()).some(job => job.nodeUid === uid)
  }

  return {
    enqueue({ mindMap, node, onSuccess, onError, onStart }) {
      const validation = validateFlowExpandNode(node)
      if (!validation.ok) {
        return { ok: false, message: validation.message }
      }
      const uid = nodeUid(node)
      if (hasNode(uid)) {
        return { ok: false, message: '该节点已在补齐队列中' }
      }
      const job = {
        id: nextJobId(),
        nodeUid: uid,
        nodeLabel: validation.label,
        mindMap,
        node,
        state: 'queued',
        status: '排队中…',
        onSuccess,
        onError,
        onStart
      }
      pending.push(job)
      emit()
      pump()
      return { ok: true, job }
    },

    cancel(jobId) {
      const idx = pending.findIndex(job => job.id === jobId)
      if (idx >= 0) {
        pending.splice(idx, 1)
        emit()
        pump()
        return true
      }
      const controller = controllers.get(jobId)
      if (controller) {
        controller.abort()
        return true
      }
      return false
    },

    cancelAll() {
      pending.splice(0, pending.length)
      finishing.forEach(timer => clearTimeout(timer))
      finishing.clear()
      controllers.forEach(controller => controller.abort())
      emit()
    },

    getSnapshot: snapshot
  }
}
