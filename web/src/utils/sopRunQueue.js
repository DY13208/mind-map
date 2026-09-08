/**
 * SOP 台账运行队列：复用 WorkBuddy 多会话（独立 conversationId）
 * 形态对齐 flowExpandQueue，默认并发 2、上限 3
 */
import { runSopWithWorkbuddy } from './sopRun'
import { getLocalConfig } from '@/api'

let jobSeq = 0

function nextJobId() {
  jobSeq += 1
  return `sop-run-${Date.now()}-${jobSeq}`
}

function clampConcurrency(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return 2
  return Math.min(3, Math.max(1, Math.round(v)))
}

export function resolveSopRunConcurrency() {
  try {
    const cfg = getLocalConfig() || {}
    // 与流程补齐共用配置；未配置时默认 2
    return clampConcurrency(
      cfg.sopRunConcurrency != null
        ? cfg.sopRunConcurrency
        : cfg.flowExpandConcurrency != null
          ? cfg.flowExpandConcurrency
          : 2
    )
  } catch (e) {
    return 2
  }
}

function sopJobKey(roomKey, sopUid) {
  return `${String(roomKey || '').trim()}::${String(sopUid || '').trim()}`
}

function formatEventTime(ts) {
  const d = new Date(ts || Date.now())
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function toolResultSnippet(raw) {
  if (!raw || typeof raw !== 'object') return ''
  if (String(raw.type || '') !== 'workbuddy.tool_result') return ''
  const text = String(raw.text || '').trim()
  if (!text) return ''
  const one = text.replace(/\s+/g, ' ').slice(0, 160)
  return one ? `  ↳ ${one}${text.length > 160 ? '…' : ''}` : ''
}

function publicJob(job, extra = {}) {
  return {
    id: job.id,
    roomKey: job.roomKey,
    sopUid: job.sopUid,
    sopRowKey: job.sopRowKey,
    sopId: job.sopId,
    sopTitle: job.sopTitle,
    state: job.state,
    status: job.status,
    streamText: job.streamText,
    progressText: job.progressText,
    eventLog: job.eventLog,
    context: job.context,
    result: job.result,
    error: job.error,
    model: job.model,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    ...extra
  }
}

export function createSopRunQueue({ getConcurrency, onChange } = {}) {
  const pending = []
  const running = new Map()
  const recent = []
  const controllers = new Map()
  const finishing = new Map()

  const concurrency = () =>
    clampConcurrency(
      (getConcurrency && getConcurrency()) || resolveSopRunConcurrency()
    )

  const snapshot = () => {
    let slot = 0
    const runningJobs = Array.from(running.values()).map(job => {
      if (job.state === 'running') {
        slot += 1
        return publicJob(job, { slotIndex: slot })
      }
      return publicJob(job)
    })
    return {
      pending: pending.map((job, index) =>
        publicJob(job, { state: 'queued', queueIndex: index + 1 })
      ),
      running: runningJobs,
      recent: recent.map(job => publicJob(job)),
      queuedCount: pending.length,
      runningCount: Array.from(running.values()).filter(j => j.state === 'running')
        .length,
      total: pending.length + running.size,
      concurrency: concurrency()
    }
  }

  const emit = () => {
    if (onChange) onChange(snapshot())
  }

  const hasActive = (roomKey, sopUid) => {
    const key = sopJobKey(roomKey, sopUid)
    if (!sopUid) return false
    if (pending.some(job => sopJobKey(job.roomKey, job.sopUid) === key)) {
      return true
    }
    return Array.from(running.values()).some(
      job =>
        sopJobKey(job.roomKey, job.sopUid) === key &&
        (job.state === 'running' || job.state === 'queued')
    )
  }

  const pushRecent = job => {
    recent.unshift(publicJob(job))
    if (recent.length > 12) recent.length = 12
  }

  const pump = () => {
    const limit = concurrency()
    while (running.size < limit && pending.length) {
      const job = pending.shift()
      running.set(job.id, job)
      job.state = 'running'
      job.status = '准备中…'
      job.startedAt = Date.now()
      emit()
      if (job.onStart) job.onStart(publicJob(job))
      runJob(job)
    }
    emit()
  }

  const finishJob = (job, outcome) => {
    controllers.delete(job.id)
    job.finishedAt = Date.now()
    if (outcome && outcome.cancelled) {
      job.state = 'cancelled'
      job.status = '已取消'
      running.delete(job.id)
      pushRecent(job)
      emit()
      pump()
      return
    }
    if (outcome && outcome.error) {
      job.state = 'error'
      job.error = outcome.error
      job.status = outcome.error
      running.delete(job.id)
      pushRecent(job)
      emit()
      pump()
      return
    }
    job.state = 'done'
    job.status = job.status || '已完成'
    emit()
    pushRecent(job)
    const timer = setTimeout(() => {
      finishing.delete(job.id)
      running.delete(job.id)
      emit()
      pump()
    }, 1500)
    finishing.set(job.id, timer)
  }

  const runJob = async job => {
    const controller =
      typeof AbortController !== 'undefined' ? new AbortController() : null
    if (controller) controllers.set(job.id, controller)
    try {
      const result = await runSopWithWorkbuddy({
        roomKey: job.roomKey,
        sop: job.sop,
        outputIds: job.outputIds,
        extraNote: job.extraNote,
        model: job.model,
        actor: job.actor,
        conversationId: job.id,
        signal: controller && controller.signal,
        onStatus: text => {
          job.status = text
          emit()
        },
        onContext: ctx => {
          job.context = ctx
          emit()
        },
        onDelta: text => {
          job.streamText = String(text || '')
          emit()
        },
        onEventDetail: ({ label, at, raw }) => {
          if (!label) return
          job.eventLog.push({
            label,
            time: formatEventTime(at)
          })
          if (job.eventLog.length > 80) {
            job.eventLog = job.eventLog.slice(-80)
          }
          if (!job.streamText) {
            const tip = `› ${label}`
            const lines = String(job.progressText || '')
              .split('\n')
              .filter(Boolean)
            if (lines[lines.length - 1] !== tip) {
              lines.push(tip)
              job.progressText = lines.slice(-40).join('\n')
            }
            const snippet = toolResultSnippet(raw)
            if (snippet) {
              job.progressText =
                (job.progressText ? job.progressText + '\n' : '') + snippet
            }
          }
          emit()
        }
      })
      if (!job.streamText && result.reply) {
        job.streamText = result.reply
      }
      job.result = {
        ok: result.ok,
        runResult: result.runResult,
        elapsedSec: result.elapsedSec,
        reply: result.reply,
        deliverables: result.deliverables || [],
        ledger: result.ledger,
        assessment: result.assessment,
        toolEvents:
          (result.assessment && result.assessment.toolEvents) ||
          ((result.events && result.events.length) || 0)
      }
      job.status = result.ok
        ? `已完成（约 ${result.elapsedSec}s）`
        : `结束：${(result.assessment && result.assessment.reason) || result.runResult || '未确认真执行'}`
      if (job.onSuccess) job.onSuccess(result, publicJob(job))
      finishJob(job, { ok: true })
    } catch (err) {
      if (err && err.name === 'AbortError') {
        if (job.onError) job.onError(err, '已取消')
        finishJob(job, { cancelled: true })
        return
      }
      const raw = (err && err.message) || String(err || '')
      const msg =
        (err && err.status >= 500) ||
        /Failed to fetch|NetworkError|ECONNREFUSED|Bad Gateway|<!DOCTYPE html>/i.test(
          raw
        )
          ? '连不上 WorkBuddy，请确认本机已启动 WorkBuddy API 代理'
          : raw || 'SOP 执行失败'
      job.error = msg
      job.status = msg
      if (err && err.ledger) {
        job.result = {
          ok: false,
          runResult: '失败',
          elapsedSec: err.elapsedSec || 0,
          reply: '',
          deliverables: [],
          ledger: err.ledger,
          toolEvents: (err.events && err.events.length) || 0
        }
      }
      if (job.onError) job.onError(err, msg)
      finishJob(job, { error: msg })
    }
  }

  return {
    enqueue({
      roomKey,
      sop,
      outputIds,
      extraNote,
      model,
      actor,
      onSuccess,
      onError,
      onStart
    }) {
      if (!roomKey) {
        return { ok: false, message: '请先选择空间' }
      }
      if (!sop || !sop.title) {
        return { ok: false, message: '缺少 SOP' }
      }
      const sopUid = sop.uid || (sop.uids && sop.uids[0]) || ''
      if (!sopUid) {
        return { ok: false, message: '找不到该 SOP 对应的节点' }
      }
      if (!(outputIds && outputIds.length)) {
        return { ok: false, message: '请至少选择一种产物' }
      }
      if (hasActive(roomKey, sopUid)) {
        return { ok: false, message: '该 SOP 已在运行或排队中' }
      }
      const job = {
        id: nextJobId(),
        roomKey: String(roomKey).trim(),
        sopUid,
        sopRowKey: sop.rowKey || '',
        sopId: sop.id || '',
        sopTitle: sop.title || '',
        sop,
        outputIds: (outputIds || []).slice(),
        extraNote: extraNote || '',
        model: model || '',
        actor: actor || '台账',
        state: 'queued',
        status: '排队中…',
        streamText: '',
        progressText: '',
        eventLog: [],
        context: null,
        result: null,
        error: '',
        startedAt: 0,
        finishedAt: 0,
        onSuccess,
        onError,
        onStart
      }
      pending.push(job)
      emit()
      pump()
      return { ok: true, job: publicJob(job) }
    },

    cancel(jobId) {
      const idx = pending.findIndex(job => job.id === jobId)
      if (idx >= 0) {
        const [job] = pending.splice(idx, 1)
        job.state = 'cancelled'
        job.status = '已取消'
        job.finishedAt = Date.now()
        pushRecent(job)
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
      while (pending.length) {
        const job = pending.shift()
        job.state = 'cancelled'
        job.status = '已取消'
        job.finishedAt = Date.now()
        pushRecent(job)
      }
      finishing.forEach(timer => clearTimeout(timer))
      finishing.clear()
      controllers.forEach(controller => {
        try {
          controller.abort()
        } catch (e) {
          /* ignore */
        }
      })
      emit()
    },

    findActiveBySop(roomKey, sopUid) {
      const key = sopJobKey(roomKey, sopUid)
      const fromPending = pending.find(
        job => sopJobKey(job.roomKey, job.sopUid) === key
      )
      if (fromPending) return publicJob(fromPending, { state: 'queued' })
      const fromRunning = Array.from(running.values()).find(
        job =>
          sopJobKey(job.roomKey, job.sopUid) === key &&
          job.state === 'running'
      )
      return fromRunning ? publicJob(fromRunning) : null
    },

    getJob(jobId) {
      const p = pending.find(job => job.id === jobId)
      if (p) return publicJob(p, { state: 'queued' })
      const r = running.get(jobId)
      if (r) return publicJob(r)
      const done = recent.find(job => job.id === jobId)
      return done || null
    },

    getSnapshot: snapshot
  }
}
