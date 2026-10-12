import { nodeUid } from '@/utils/flowExpandPrompt'
import {
  runFlowExpandJob,
  validateFlowExpandNode
} from '@/utils/flowExpandRunner'

let jobSeq = 0

function nextJobId() {
  jobSeq += 1
  return `flow-expand-${Date.now()}-${jobSeq}`
}

export function createFlowExpandQueue({ getConcurrency, onChange, maxWaitMs = 60000 }) {
  const deadlines = new Map()
  const pending = []
  const running = new Map()
  const controllers = new Map()
  const previews = new Map(),
    pollTimers = new Map()

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
      preview: Array.from(previews.values()).map(job => ({ ...job })),
      queuedCount: pending.length,
      runningCount: running.size,
      total: pending.length + running.size + previews.size,
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
    clearTimeout(deadlines.get(job.id)); deadlines.delete(job.id)
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

  const stopPreview = id => {
    clearTimeout(pollTimers.get(id))
    pollTimers.delete(id)
    previews.get(id) &&
      (previews.get(id).previewEpoch = (previews.get(id).previewEpoch || 0) + 1)
    previews.delete(id)
    clearTimeout(deadlines.get(id)); deadlines.delete(id)
    const controller = controllers.get(id)
    if (controller) {
      controllers.delete(id)
      controller.abort()
    }
  }
  const waiting = result =>
    result.reason !== 'conflict' &&
    (!!result.coverage?.pending ||
      result.reason === 'local_revision_changed' ||
      (!result.written &&
        result.canCommit &&
        result.reason !== 'already_exists'))
  const schedulePoll = job => {
    if (!previews.has(job.id)) return
    pollTimers.set(
      job.id,
      setTimeout(() => pollPreview(job), 5000 * Math.pow(2, job.retryErrors || 0))
    )
  }
  const pollPreview = async job => {
    if (previews.get(job.id) !== job) return
    if ((job.mindMap.cooperate && job.mindMap.cooperate.httpRoomKey !== job.result.localContext?.roomId) || (job.mindMap.renderer?.findNodeByUid && !job.mindMap.renderer.findNodeByUid(job.nodeUid))) { stopPreview(job.id); emit(); pump(); return }
    const epoch = job.previewEpoch,
      controller = new AbortController()
    controllers.set(job.id, controller)
    try {
      const result = await runFlowExpandJob({
        mindMap: job.mindMap,
        node: job.node,
        localOnly: true,
        localMode: 'preview',
        autoCommit: !job.totalWritten,
        expectedContext: job.result.localContext,
        signal: controller.signal
      })
      if (previews.get(job.id) !== job || job.previewEpoch !== epoch) return
      if (result.written) {
        job.totalWritten = (job.totalWritten || 0) + result.written
        if (job.onSuccess) job.onSuccess(result)
      }
      job.result = result
      job.status =
        (!result.written && job.totalWritten
          ? `已补入 ${job.totalWritten} 条；`
          : '') + result.status
      job.error = ''
      job.retryErrors = 0
      emit()
      if (!waiting(result) || (job.totalWritten && !result.coverage?.pending)) {
        stopPreview(job.id)
        if (job.onSuccess) {
          if (!job.totalWritten) job.onSuccess(result)
          else if (result.canCommit)
            job.onSuccess({
              ...result,
              written: 0,
              status: '后台核查发现更多原文，请再次补齐查看'
            })
        }
        emit()
        pump()
      }
    } catch (error) {
      if (
        previews.get(job.id) !== job ||
        job.previewEpoch !== epoch ||
        error.name === 'AbortError'
      )
        return
      job.retryErrors = (job.retryErrors || 0) + 1
      if (job.retryErrors > 3) { stopPreview(job.id); job.onError?.(error,'补齐查询失败，已停止等待，可重新补齐'); emit(); pump(); return }
      job.error = error.message
      job.status = error.message
      job.result = { ...job.result, canCommit: false }
      emit()
    } finally {
      if (controllers.get(job.id) === controller) controllers.delete(job.id)
      if (job.previewEpoch === epoch) schedulePoll(job)
    }
  }
  const showPreview = (job, result) => {
    controllers.delete(job.id)
    running.delete(job.id)
    job.previewEpoch = (job.previewEpoch || 0) + 1
    job.state = 'preview'
    job.totalWritten = (job.totalWritten || 0) + (result.written || 0)
    job.result = result
    job.status =
      (!result.written && job.totalWritten
        ? `已补入 ${job.totalWritten} 条；`
        : '') + result.status
    previews.set(job.id, job)
    emit()
    schedulePoll(job)
    pump()
  }

  const runJob = async job => {
    const controller =
      typeof AbortController !== 'undefined' ? new AbortController() : null
    if (controller) controllers.set(job.id, controller)
    if (!deadlines.has(job.id)) deadlines.set(job.id, setTimeout(() => {
      const active = previews.has(job.id) || running.has(job.id) || pollTimers.has(job.id) || pending.some(j=>j.id===job.id)
      if (!active) return
      clearTimeout(pollTimers.get(job.id)); pollTimers.delete(job.id)
      const pendingIndex=pending.findIndex(j=>j.id===job.id); if(pendingIndex>=0)pending.splice(pendingIndex,1)
      if (previews.has(job.id)) stopPreview(job.id)
      else { controllers.get(job.id)?.abort(); controllers.delete(job.id); running.delete(job.id) }
      job.onSuccess?.({ written:0, reason:'waiting_timeout', status:'资料仍在后台处理，可稍后再次补齐' })
      emit(); pump()
    }, maxWaitMs))
    try {
      const result = await runFlowExpandJob({
        mindMap: job.mindMap,
        node: job.node,
        conversationId: job.id,
        signal: controller && controller.signal,
        localMode: job.commit ? 'commit' : 'preview',
        autoCommit: !job.commit,
        localOnly: !!job.commit,
        revision: job.commit ? job.result?.revision : undefined,
        expectedContext: job.commit ? job.result?.localContext : undefined,
        onStatus: status => {
          job.status = status
          emit()
        }
      })
      if (controller?.signal.aborted) { finishJob(job,{cancelled:true}); return }
      job.status = result.status || '未新增子节点'
      job.result = result
      if (result.localContext && waiting(result)) {
        if (result.written && job.onSuccess) job.onSuccess(result)
        else if (!job.totalWritten && job.onSuccess)
          job.onSuccess({
            ...result,
            status: '相关资料正在后台解析，完成后自动补齐'
          })
        job.commit = false
        showPreview(job, result)
        return
      }
      if (job.onSuccess) job.onSuccess(result)
      finishJob(job, { ok: true })
    } catch (err) {
      if (controller?.signal.aborted || running.get(job.id) !== job || (err && err.name === 'AbortError')) {
        job.status = '已取消'
        finishJob(job, { cancelled: true })
        return
      }
      const raw = (err && err.message) || String(err || '')
      if ((err?.status >= 500 || /Failed to fetch|NetworkError|ECONNREFUSED/.test(raw)) && (job.retryErrors || 0) < 3) {
        job.retryErrors = (job.retryErrors || 0)+1; controllers.delete(job.id)
        const timer=setTimeout(()=>{pollTimers.delete(job.id);if(controller?.signal.aborted || running.get(job.id)!==job)return;running.delete(job.id);pending.push(job);pump()},1000*Math.pow(2,job.retryErrors-1)); pollTimers.set(job.id,timer); emit(); pump(); return
      }
      const msg =
        (err && err.status >= 500) ||
        /Failed to fetch|NetworkError|ECONNREFUSED|Bad Gateway|<!DOCTYPE html>/i.test(
          raw
        )
          ? '连不上 wiki-compiler，请确认图谱服务已启动'
          : raw || 'Wiki 检索失败'
      job.status = msg
      job.error = msg
      if (job.onError) job.onError(err, msg)
      finishJob(job, { error: msg })
    }
  }

  const hasNode = uid => {
    if (!uid) return false
    if (pending.some(job => job.nodeUid === uid)) return true
    return (
      Array.from(running.values()).some(job => job.nodeUid === uid) ||
      Array.from(previews.values()).some(job => job.nodeUid === uid)
    )
  }

  return {
    enqueue({ mindMap, node, onSuccess, onError, onStart }) {
      const validation = validateFlowExpandNode(node)
      if (!validation.ok) {
        return { ok: false, message: validation.message }
      }
      const uid = nodeUid(node)
      const preview = Array.from(previews.values()).find(job=>job.nodeUid===uid)
      if (preview) {
        clearTimeout(pollTimers.get(preview.id)); pollTimers.delete(preview.id)
        controllers.get(preview.id)?.abort(); controllers.delete(preview.id)
        preview.previewEpoch = (preview.previewEpoch || 0) + 1
        pollPreview(preview)
        return {ok:true,job:preview,reused:true}
      }
      if (hasNode(uid)) {
        return { ok: false, message: '正在查询该节点，请稍候' }
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

    commit(jobId) {
      const job = previews.get(jobId)
      if (!job || !job.result?.canCommit) return false
      stopPreview(jobId)
      job.commit = true
      pending.push(job)
      emit()
      pump()
      return true
    },

    cancel(jobId) {
      if (!previews.has(jobId) && pollTimers.has(jobId)) { clearTimeout(pollTimers.get(jobId));pollTimers.delete(jobId);clearTimeout(deadlines.get(jobId));deadlines.delete(jobId);running.delete(jobId);emit();pump();return true }
      if (previews.has(jobId)) {
        stopPreview(jobId)
        emit()
        return true
      }
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
      pollTimers.forEach(timer=>clearTimeout(timer)); pollTimers.clear()
      deadlines.forEach(timer=>clearTimeout(timer)); deadlines.clear()
      for (const id of previews.keys()) stopPreview(id)
      pending.splice(0, pending.length)
      finishing.forEach(timer => clearTimeout(timer))
      finishing.clear()
      for (const [id, job] of running)
        if (job.state === 'done') running.delete(id)
      controllers.forEach(controller => controller.abort())
      controllers.clear(); running.clear()
      emit()
    },

    getSnapshot: snapshot
  }
}
