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
    waitingTaskUids: job.waitingTaskUids || [],
    notifyResults: job.notifyResults || [],
    missingFields: job.missingFields || [],
    missingSummary: job.missingSummary || '',
    ...extra
  }
}

function notifyCount(result) {
  return ((result && result.notifyResults) || []).filter(r => r && r.block)
    .length
}

const QUEUE_STORAGE_KEY = 'lc_sop_run_queue_v1'
const STREAM_PERSIST_MAX = 200000

function serializeJob(job) {
  return {
    id: job.id,
    roomKey: job.roomKey,
    sopUid: job.sopUid,
    sopRowKey: job.sopRowKey,
    sopId: job.sopId,
    sopTitle: job.sopTitle,
    sop: job.sop,
    outputIds: (job.outputIds || []).slice(),
    extraNote: job.extraNote || '',
    model: job.model || '',
    actor: job.actor || '',
    state: job.state,
    status: job.status,
    streamText: String(job.streamText || '').slice(0, STREAM_PERSIST_MAX),
    progressText: String(job.progressText || '').slice(0, 20000),
    eventLog: (job.eventLog || []).slice(-80),
    context: job.context || null,
    result: job.result || null,
    error: job.error || '',
    startedAt: job.startedAt || 0,
    finishedAt: job.finishedAt || 0,
    waitingTaskUids: (job.waitingTaskUids || []).slice(),
    notifyResults: (job.notifyResults || []).slice(),
    missingFields: (job.missingFields || []).slice(),
    missingSummary: job.missingSummary || '',
    skipNotifyOnResume: !!job.skipNotifyOnResume
  }
}

function hydrateJob(raw) {
  if (!raw || !raw.id) return null
  return {
    id: raw.id,
    roomKey: raw.roomKey || '',
    sopUid: raw.sopUid || '',
    sopRowKey: raw.sopRowKey || '',
    sopId: raw.sopId || '',
    sopTitle: raw.sopTitle || '',
    sop: raw.sop || {
      uid: raw.sopUid,
      id: raw.sopId,
      title: raw.sopTitle,
      rowKey: raw.sopRowKey
    },
    outputIds: (raw.outputIds || []).slice(),
    extraNote: raw.extraNote || '',
    model: raw.model || '',
    actor: raw.actor || '台账',
    state: raw.state || 'queued',
    status: raw.status || '',
    streamText: raw.streamText || '',
    progressText: raw.progressText || '',
    eventLog: (raw.eventLog || []).slice(),
    context: raw.context || null,
    result: raw.result || null,
    error: raw.error || '',
    startedAt: raw.startedAt || 0,
    finishedAt: raw.finishedAt || 0,
    waitingTaskUids: (raw.waitingTaskUids || []).slice(),
    notifyResults: (raw.notifyResults || []).slice(),
    missingFields: (raw.missingFields || []).slice(),
    missingSummary: raw.missingSummary || '',
    skipNotifyOnResume: !!raw.skipNotifyOnResume,
    onSuccess: null,
    onError: null,
    onStart: null,
    onWaiting: null
  }
}

function readPersistedQueue() {
  try {
    if (typeof sessionStorage === 'undefined') return null
    const raw = sessionStorage.getItem(QUEUE_STORAGE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object') return null
    return data
  } catch (e) {
    return null
  }
}

function writePersistedQueue(payload) {
  try {
    if (typeof sessionStorage === 'undefined') return
    const empty =
      !payload ||
      (!(payload.waiting && payload.waiting.length) &&
        !(payload.pending && payload.pending.length) &&
        !(payload.running && payload.running.length) &&
        !(payload.recent && payload.recent.length))
    if (empty) {
      sessionStorage.removeItem(QUEUE_STORAGE_KEY)
      return
    }
    sessionStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(payload))
  } catch (e) {
    /* quota / private mode */
  }
}

export function createSopRunQueue({ getConcurrency, onChange } = {}) {
  const pending = []
  const running = new Map()
  const waiting = new Map()
  const recent = []
  const controllers = new Map()
  const finishing = new Map()
  let persistTimer = null

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
    const waitingJobs = Array.from(waiting.values()).map(job =>
      publicJob(job)
    )
    return {
      pending: pending.map((job, index) =>
        publicJob(job, { state: 'queued', queueIndex: index + 1 })
      ),
      running: runningJobs,
      waiting: waitingJobs,
      recent: recent.map(job => publicJob(job)),
      queuedCount: pending.length,
      runningCount: Array.from(running.values()).filter(j => j.state === 'running')
        .length,
      waitingCount: waiting.size,
      total: pending.length + running.size + waiting.size,
      concurrency: concurrency()
    }
  }

  const persistNow = () => {
    writePersistedQueue({
      savedAt: Date.now(),
      pending: pending.map(serializeJob),
      waiting: Array.from(waiting.values()).map(serializeJob),
      // 仅用于刷新后标记中断并保留流式输出，不会续跑
      running: Array.from(running.values())
        .filter(j => j.state === 'running')
        .map(serializeJob),
      recent: recent.slice(0, 12).map(j => {
        if (j && j.sop) return serializeJob(j)
        // recent 里已是 publicJob，补一个最小 sop 以便恢复展示
        return serializeJob(
          hydrateJob({
            ...j,
            sop: j.sop || {
              uid: j.sopUid,
              id: j.sopId,
              title: j.sopTitle,
              rowKey: j.sopRowKey
            }
          })
        )
      })
    })
  }

  const schedulePersist = () => {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistNow()
    }, 400)
  }

  const emit = () => {
    schedulePersist()
    if (changeHandler) changeHandler(snapshot())
  }

  let changeHandler = onChange

  // 整页刷新后从 sessionStorage 恢复等待/排队任务（流式输出、待补数）
  const restored = readPersistedQueue()
  if (restored) {
    ;(restored.waiting || []).forEach(raw => {
      const job = hydrateJob(raw)
      if (!job) return
      if (job.state !== 'waiting_data' && job.state !== 'waiting_human') {
        job.state = job.missingFields && job.missingFields.length
          ? 'waiting_data'
          : 'waiting_human'
      }
      waiting.set(job.id, job)
    })
    ;(restored.pending || []).forEach(raw => {
      const job = hydrateJob(raw)
      if (!job) return
      job.state = 'queued'
      job.status = job.status || '刷新后恢复排队…'
      pending.push(job)
    })
    ;(restored.recent || []).forEach(raw => {
      const job = hydrateJob(raw)
      if (!job) return
      recent.push(publicJob(job))
    })
    // 刷新前若有 running：请求已断，记为中断并保留流式输出
    ;(restored.running || []).forEach(raw => {
      const job = hydrateJob(raw)
      if (!job) return
      job.state = 'error'
      job.error = '页面刷新导致执行中断（可重新点运行）'
      job.status = job.error
      job.finishedAt = Date.now()
      recent.unshift(publicJob(job))
    })
    if (recent.length > 12) recent.length = 12
  }

  const hasActive = (roomKey, sopUid) => {
    const key = sopJobKey(roomKey, sopUid)
    if (!sopUid) return false
    if (pending.some(job => sopJobKey(job.roomKey, job.sopUid) === key)) {
      return true
    }
    if (
      Array.from(waiting.values()).some(
        job => sopJobKey(job.roomKey, job.sopUid) === key
      )
    ) {
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
        skipNotify: !!job.skipNotifyOnResume,
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
        waiting: !!result.waitingHuman || !!result.waitingData,
        waitingData: !!result.waitingData,
        missingFields: result.missingFields || [],
        missingSummary: result.missingSummary || '',
        notifyResults: result.notifyResults || [],
        toolEvents:
          (result.assessment && result.assessment.toolEvents) ||
          ((result.events && result.events.length) || 0)
      }
      if (result.waitingHuman || result.waitingData) {
        job.state = result.waitingData ? 'waiting_data' : 'waiting_human'
        job.waitingTaskUids = result.waitingTaskUids || []
        job.notifyResults = result.notifyResults || []
        job.missingFields = result.missingFields || []
        job.missingSummary = result.missingSummary || ''
        job.skipNotifyOnResume = true
        job.status = result.waitingData
          ? `待补数：${result.missingSummary || '请补充缺失数据后继续'}`
          : `等待人工完成 ${
              job.waitingTaskUids.length || notifyCount(result)
            } 条阻塞待办后再继续`
        controllers.delete(job.id)
        running.delete(job.id)
        waiting.set(job.id, job)
        if (job.onWaiting) job.onWaiting(result, publicJob(job))
        emit()
        pump()
        return
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

  const api = {
    enqueue({
      roomKey,
      sop,
      outputIds,
      extraNote,
      model,
      actor,
      onSuccess,
      onError,
      onStart,
      onWaiting
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
      if (hasActive(roomKey, sopUid)) {
        return { ok: false, message: '该 SOP 已在运行、排队或等待人工中' }
      }
      // 深拷贝，避免多任务共享同一 sopLedger/deliverables 引用导致串台
      let sopCopy = sop
      try {
        sopCopy = JSON.parse(JSON.stringify(sop))
      } catch (e) {
        sopCopy = { ...sop }
      }
      sopCopy.uid = sopUid
      const job = {
        id: nextJobId(),
        roomKey: String(roomKey).trim(),
        sopUid,
        sopRowKey: sop.rowKey || '',
        sopId: sop.id || '',
        sopTitle: sop.title || '',
        sop: sopCopy,
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
        waitingTaskUids: [],
        notifyResults: [],
        skipNotifyOnResume: false,
        onSuccess,
        onError,
        onStart,
        onWaiting
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
      if (waiting.has(jobId)) {
        const job = waiting.get(jobId)
        waiting.delete(jobId)
        job.state = 'cancelled'
        job.status = '已取消（原等待人工）'
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
      waiting.forEach(job => {
        job.state = 'cancelled'
        job.status = '已取消（原等待人工）'
        job.finishedAt = Date.now()
        pushRecent(job)
      })
      waiting.clear()
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
      const fromWaiting = Array.from(waiting.values()).find(
        job => sopJobKey(job.roomKey, job.sopUid) === key
      )
      if (fromWaiting) {
        return publicJob(fromWaiting)
      }
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
      const w = waiting.get(jobId)
      if (w) return publicJob(w)
      const r = running.get(jobId)
      if (r) return publicJob(r)
      const done = recent.find(job => job.id === jobId)
      return done || null
    },

    /** 人工待办完成 / 补数后继续执行（跳过已派发的通知节点） */
    resumeWaiting(jobId, { extraNoteAppend = '' } = {}) {
      const job = waiting.get(jobId)
      if (!job) return { ok: false, message: '没有等待中的任务' }
      const wasData = job.state === 'waiting_data'
      waiting.delete(jobId)
      job.state = 'queued'
      job.status = wasData
        ? '已补数，重新入队继续…'
        : '待办已完成，重新入队继续…'
      job.skipNotifyOnResume = true
      if (extraNoteAppend) {
        job.extraNote = [job.extraNote || '', extraNoteAppend]
          .filter(Boolean)
          .join('\n\n')
      }
      job.streamText = ''
      job.progressText = ''
      job.error = ''
      job.missingFields = []
      job.missingSummary = ''
      pending.unshift(job)
      emit()
      pump()
      return { ok: true, job: publicJob(job) }
    },

    listWaiting() {
      return Array.from(waiting.values()).map(job => publicJob(job))
    },

    getSnapshot: snapshot,

    setOnChange(handler) {
      changeHandler = handler
      if (changeHandler) changeHandler(snapshot())
    },

    /** 收集队列里已回写的台账，供刷新列表时合并，避免冲掉刚跑完的记录 */
    collectLedgers(roomKey) {
      const key = String(roomKey || '').trim()
      const map = new Map()
      const take = job => {
        if (!job || (key && job.roomKey !== key)) return
        const ledger =
          (job.result && job.result.ledger) ||
          (job.error && job.error.ledger) ||
          null
        if (!ledger || !job.sopUid) return
        const prev = map.get(job.sopUid)
        map.set(
          job.sopUid,
          prev ? mergeLedgerLoose(prev, ledger) : ledger
        )
      }
      pending.forEach(take)
      running.forEach(take)
      waiting.forEach(take)
      recent.forEach(take)
      return map
    }
  }

  // 恢复排队任务后继续泵；立刻落盘
  if (pending.length) {
    setTimeout(() => {
      try {
        pump()
      } catch (e) {
        /* ignore */
      }
    }, 0)
  }
  persistNow()

  return api
}

function mergeLedgerLoose(a, b) {
  try {
    // 轻量合并：优先保留条数更多的一侧，再拼 runs/deliverables
    const ra = (a && a.runs) || []
    const rb = (b && b.runs) || []
    const da = (a && a.deliverables) || []
    const db = (b && b.deliverables) || []
    const runKey = r => `${r && r.at}|${r && r.result}|${r && r.note}`
    const delKey = d => `${d && d.name}|${d && d.uri_or_path}`
    const runs = new Map()
    ;[...rb, ...ra].forEach(r => r && runs.set(runKey(r), r))
    const dels = new Map()
    ;[...db, ...da].forEach(d => d && dels.set(delKey(d), d))
    const freq =
      (a && a.frequency && a.frequency.label !== '未知' && a.frequency) ||
      (b && b.frequency) ||
      (a && a.frequency) ||
      { label: '未知', cron_hint: null }
    return {
      frequency: freq,
      runs: Array.from(runs.values()),
      deliverables: Array.from(dels.values())
    }
  } catch (e) {
    return b || a
  }
}

let sharedSopRunQueue = null

/**
 * 台账页单例队列：组件销毁/刷新列表时不中断正在跑的 SOP
 */
export function getSharedSopRunQueue(options = {}) {
  if (!sharedSopRunQueue) {
    sharedSopRunQueue = createSopRunQueue(options)
  } else if (options.onChange) {
    sharedSopRunQueue.setOnChange(options.onChange)
  }
  return sharedSopRunQueue
}
