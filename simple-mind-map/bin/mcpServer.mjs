#!/usr/bin/env node

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { buildSopContext } from './sopContext.mjs'
import { registerLeaveTools, registerApprovalTools } from './leaveWorkflow/mcp.mjs'
import mcpUserToken from './mcpUserToken.js'
import {
  resolveAttachmentUploadInput,
  uploadAttachmentAndMountNode
} from './mcpAttachmentUpload.mjs'
import { deleteNodeAttachment } from './mcpAttachmentDelete.mjs'
import mcpSubmitGateModule from './mcpSubmitGate.js'
import mcpHyperlink from './mcpHyperlink.js'
import performanceDiagnosticsModule from './performanceDiagnostics.js'
import { createMcpHttpLifecycle } from './mcpHttpDiagnostics.mjs'

const { bearerToken, verifyMcpUserToken } = mcpUserToken
const { createMcpSubmitGate } = mcpSubmitGateModule
const { hyperlinkFields } = mcpHyperlink
const mcpDiagnostics = performanceDiagnosticsModule
mcpDiagnostics.start()

const API = (process.env.MIND_MAP_API || 'http://127.0.0.1:1234').replace(
  /\/$/,
  ''
)
const MCP_PORT = Number(process.env.MCP_PORT || 3847)
const MCP_HOST = process.env.MCP_HOST || '0.0.0.0'
const MCP_TOKEN = process.env.MCP_TOKEN || ''
const mcpSubmitGate = createMcpSubmitGate()
// Collab V2 requireClientId rejects empty clientId on all writes; MCP tools
// historically only sent business fields. Stable per-process id keeps ops
// attributable without forcing every tool payload to pass clientId.
const MCP_CLIENT_ID =
  String(process.env.MCP_CLIENT_ID || '')
    .trim()
    .slice(0, 160) || `mcp-${randomUUID()}`

function ok(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }]
  }
}

function okWrite(data) {
  if (data && data.outcome === 'all_failed') {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(data) }],
      structuredContent: data
    }
  }
  return ok(data)
}

function fail(err) {
  const result = {
    isError: true,
    content: [{ type: 'text', text: err.message || String(err) }]
  }
  if (
    err.operationId ||
    err.code === 'MCP_WRITE_BUSY' ||
    err.code === 'MCP_WRITE_QUEUE_TIMEOUT'
  ) {
    result.structuredContent = {
      code: err.code || 'MCP_WRITE_ERROR',
      statusCode: Number(err.statusCode || 0),
      ...(Number(err.retryAfterMs) > 0
        ? { retryAfterMs: Number(err.retryAfterMs) }
        : {}),
      ...(err.operationId ? { operation_id: err.operationId } : {}),
      ...(Number.isSafeInteger(Number(err.pinnedBaseVersion)) &&
      Number(err.pinnedBaseVersion) >= 0
        ? { base_revision: Number(err.pinnedBaseVersion) }
        : {}),
      ...(typeof err.writeSubmitted === 'boolean'
        ? { writeSubmitted: err.writeSubmitted }
        : {}),
      outcome: err.outcomeUnknown ? 'unknown' : 'rejected',
      outcomeUnknown: !!err.outcomeUnknown,
      ...(err.details ? { details: err.details } : {})
    }
  }
  return result
}

function historyFail(err) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: false,
          code: err.code || 'HISTORY_ERROR',
          error: err.message || String(err),
          statusCode: err.statusCode || 0,
          ...(err.details ? { details: err.details } : {})
        })
      }
    ]
  }
}

function attachmentDeleteFail(err) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: false,
          code: err.code || 'ATTACHMENT_DELETE_ERROR',
          error: err.message || String(err),
          statusCode: err.statusCode || 0,
          ...(err.details ? { details: err.details } : {})
        })
      }
    ]
  }
}

function attachmentUploadFail(err) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: false,
          code: err.code || 'ATTACHMENT_UPLOAD_ERROR',
          error: err.message || String(err),
          statusCode: err.statusCode || 0,
          ...(err.details ? { details: err.details } : {})
        })
      }
    ]
  }
}

function historySummary(summary = {}) {
  return {
    inserted: Number(summary.inserted || 0),
    updated: Number(summary.updated || 0),
    deleted: Number(summary.deleted || 0),
    moved: Number(summary.moved || 0)
  }
}

function historyVersion(version = {}) {
  return {
    versionId: version.versionId || '',
    revision: version.revision == null ? null : Number(version.revision),
    checkpointRevision: Number(version.checkpointRevision || 0),
    name: version.name || '',
    type: version.type || '',
    createdBy: version.createdBy || '',
    createdById: version.createdById || '',
    createdAt: version.createdAt || '',
    description: version.description || '',
    source: version.source || '',
    sourceKind: version.sourceKind || '',
    editors: Array.isArray(version.editors) ? version.editors : [],
    summary: historySummary(version.summary),
    summaryStatus: version.summaryStatus || 'pending',
    summaryText: version.summaryText || '',
    availability: version.availability || 'readable',
    readOnly: version.readOnly !== false,
    capabilities: version.capabilities || {}
  }
}

function historyCoverage(data = {}) {
  return {
    earliestAvailableRevision: Number(data.earliestAvailableRevision || 0),
    currentRevision: Number(data.currentRevision || 0),
    completeFromRevision: Number(data.completeFromRevision || 0),
    historyStartRevision: Number(data.historyStartRevision || 0)
  }
}

async function apiRequest(pathName, options = {}) {
  const {
    timeoutMs = 25000,
    headers,
    authorization,
    signal: requestSignal,
    ...rest
  } = options
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = requestSignal
    ? AbortSignal.any([timeoutSignal, requestSignal])
    : timeoutSignal
  const res = await fetch(`${API}${pathName}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      'x-client-id': MCP_CLIENT_ID,
      ...(authorization
        ? { Authorization: authorization }
        : MCP_TOKEN
          ? { Authorization: `Bearer ${MCP_TOKEN}` }
          : {}),
      ...(headers || {})
    },
    signal
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const error = new Error(
      data.error || res.statusText || `HTTP ${res.status}`
    )
    error.code = data.code || `HTTP_${res.status}`
    error.statusCode = res.status
    if (data.details) error.details = data.details
    if (Number(data.retryAfterMs) > 0) {
      error.retryAfterMs = Number(data.retryAfterMs)
    }
    throw error
  }
  return data
}

function createServer(authorization) {
  const api = (pathName, options = {}) =>
    apiRequest(pathName, { ...options, authorization })
  const currentMapRevision = async roomKey => {
    const data = await api(
      `/api/files/${encodeURIComponent(roomKey)}?format=meta`
    )
    const revision = Number(
      data.currentRevision != null
        ? data.currentRevision
        : data.revision != null
          ? data.revision
          : data.version
    )
    if (!Number.isSafeInteger(revision) || revision < 0) {
      const err = new Error('无法获取导图当前修订号')
      err.code = 'REVISION_UNAVAILABLE'
      throw err
    }
    return revision
  }
  const writeMap = async (
    roomKey,
    pathName,
    method,
    body,
    {
      signal,
      timeoutMs = 25000,
      baseVersion,
      onBaseVersion,
      operationId,
      writeType
    } = {}
  ) => {
    const estimatedBytes = Buffer.byteLength(JSON.stringify(body || {}), 'utf8')
    const before = mcpSubmitGate.status()
    const writeStarted = Date.now()
    const enqueuedAt = writeStarted
    let writeSubmitted = false
    const type = writeType || body.type || method.toLowerCase()
    mcpDiagnostics.record({
      kind: 'mcp-queue',
      roomKey,
      operationId,
      source: 'mcp',
      type,
      stage: 'enqueue',
      outcome:
        before.activeGlobal >= before.limits.maxGlobal ||
        (before.activeByRoom[roomKey] || 0) >= before.limits.maxPerRoom
          ? 'queued'
          : 'started',
      queueDepth: before.queuedGlobal,
      queuedBytes: before.queuedBytes
    })
    try {
      return await mcpSubmitGate.run(
        roomKey,
        async () => {
          const queueStartedAt = Date.now()
          const queue = mcpSubmitGate.status()
          mcpDiagnostics.record({
            kind: 'mcp-queue',
            roomKey,
            operationId,
            source: 'mcp',
            type,
            stage: 'start',
            outcome: 'started',
            durationMs: queueStartedAt - enqueuedAt,
            queueDepth: queue.queuedGlobal,
            queuedBytes: queue.queuedBytes
          })
          const selectedBaseVersion =
            baseVersion == null ? await currentMapRevision(roomKey) : Number(baseVersion)
          if (typeof onBaseVersion === 'function') onBaseVersion(selectedBaseVersion)
          try {
            const serializedBody = JSON.stringify({
              ...body,
              baseVersion: selectedBaseVersion
            })
            writeSubmitted = true
            const result = await api(pathName, {
              method,
              timeoutMs,
              signal,
              headers: {
                'x-mcp-queue-depth': String(queue.queuedGlobal),
                'x-mcp-queue-bytes': String(queue.queuedBytes),
                'x-mcp-queue-active': String(queue.activeGlobal),
                ...(operationId ? { 'x-operation-id': operationId } : {})
              },
              body: serializedBody
            })
            const responseOutcome =
              ['applied', 'partial', 'all_failed', 'duplicate'].includes(
                String(result && result.outcome)
              )
                ? String(result.outcome)
                : result && result.duplicate
                  ? 'duplicate'
                  : result && result.ok === false
                    ? 'all_failed'
                    : 'applied'
            mcpDiagnostics.record({
              kind: 'mcp-write',
              roomKey,
              operationId,
              source: 'mcp',
              type,
              path: 'rest',
              stage: 'response',
              outcome: responseOutcome,
              durationMs: Date.now() - writeStarted,
              ok: true
            })
            return result
          } catch (err) {
            err.writeSubmitted = writeSubmitted
            const definitelyNotApplied = new Set([
              'MCP_WRITE_BUSY',
              'MCP_WRITE_QUEUE_TIMEOUT',
              'MCP_WRITE_ABORTED',
              'MCP_DIRECT_UNAVAILABLE',
              'MCP_DIRECT_REFERENCE_UNAVAILABLE',
              'MCP_BATCH_RECEIPT_SCHEMA_MISSING',
              'MCP_OPERATION_RECEIPT_SCHEMA_MISSING'
            ])
            err.outcomeUnknown =
              !definitelyNotApplied.has(String(err.code || '')) &&
              ![400, 403, 409, 423, 429].includes(Number(err.statusCode)) &&
              (!err.statusCode || Number(err.statusCode) >= 500)
            mcpDiagnostics.record({
              kind: 'mcp-write',
              roomKey,
              operationId,
              source: 'mcp',
              type,
              path: 'rest',
              stage: 'response',
              outcome: err.outcomeUnknown ? 'unknown' : 'rejected',
              code: err.code || 'MCP_WRITE_ERROR',
              durationMs: Date.now() - writeStarted,
              ok: false
            })
            throw err
          }
        },
        { signal, estimatedBytes }
      )
    } catch (err) {
      if (typeof err.writeSubmitted !== 'boolean') {
        err.writeSubmitted = writeSubmitted
      }
      mcpDiagnostics.record({
        kind: 'mcp-queue',
        roomKey,
        operationId,
        source: 'mcp',
        type,
        stage: 'reject',
        outcome: 'failed',
        code: err.code || 'MCP_WRITE_ERROR',
        queueDepth: mcpSubmitGate.status().queuedGlobal,
        queuedBytes: mcpSubmitGate.status().queuedBytes
      })
      throw err
    }
  }
  const isTransientNodeWriteError = (err, signal) => {
    if (signal && signal.aborted) return false
    if (
      err.code === 'MCP_WRITE_BUSY' ||
      err.code === 'MCP_WRITE_QUEUE_TIMEOUT' ||
      err.statusCode === 429
    ) {
      return true
    }
    if (err.statusCode) return false
    return (
      err.name === 'TypeError' ||
      err.name === 'AbortError' ||
      err.name === 'TimeoutError' ||
      ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(
        err.code
      )
    )
  }
  const waitBeforeRetry = (delayMs, signal) =>
    new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        const error = new Error('MCP 写入已取消')
        error.name = 'AbortError'
        return reject(error)
      }
      const timer = setTimeout(resolve, Math.max(1, Math.min(5000, Number(delayMs) || 250)))
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            const error = new Error('MCP 写入已取消')
            error.name = 'AbortError'
            reject(error)
          },
          { once: true }
        )
      }
    })
  const writeNodeMap = async (
    roomKey,
    pathName,
    method,
    body,
    operationId,
    { signal, baseRevision, writeType } = {}
  ) => {
    const stableBody = { ...body, operation_id: operationId }
    let unknownObserved = false
    let submittedObserved = false
    let pinnedBaseVersion =
      baseRevision == null ? null : Number(baseRevision)
    if (
      pinnedBaseVersion != null &&
      (!Number.isSafeInteger(pinnedBaseVersion) || pinnedBaseVersion < 0)
    ) {
      const err = new Error('base_revision 必须是非负整数')
      err.code = 'BAD_BASE_REVISION'
      err.statusCode = 400
      err.operationId = operationId
      err.writeSubmitted = false
      throw err
    }
    for (let retry = 0; retry <= 3; retry += 1) {
      try {
        const result = await writeMap(roomKey, pathName, method, stableBody, {
          signal,
          timeoutMs: 65000,
          baseVersion: pinnedBaseVersion,
          onBaseVersion: revision => {
            if (pinnedBaseVersion == null) pinnedBaseVersion = revision
          },
          operationId,
          writeType: writeType || stableBody.type || method.toLowerCase()
        })
        return result && typeof result === 'object' && !Array.isArray(result)
          ? { ...result, base_revision: pinnedBaseVersion }
          : result
      } catch (err) {
        err.operationId = operationId
        unknownObserved = unknownObserved || err.outcomeUnknown === true
        submittedObserved = submittedObserved || err.writeSubmitted === true
        err.writeSubmitted = submittedObserved
        if (Number.isSafeInteger(pinnedBaseVersion) && pinnedBaseVersion >= 0) {
          err.pinnedBaseVersion = pinnedBaseVersion
        }
        if (retry >= 3 || !isTransientNodeWriteError(err, signal)) {
          if (unknownObserved) err.outcomeUnknown = true
          throw err
        }
        try {
          await waitBeforeRetry(err.retryAfterMs, signal)
        } catch (waitError) {
          waitError.operationId = operationId
          waitError.writeSubmitted = submittedObserved
          if (Number.isSafeInteger(pinnedBaseVersion) && pinnedBaseVersion >= 0) {
            waitError.pinnedBaseVersion = pinnedBaseVersion
          }
          if (unknownObserved) waitError.outcomeUnknown = true
          throw waitError
        }
      }
    }
    throw new Error('MCP 节点写入重试失败')
  }
  const server = new McpServer(
    {
      name: 'mind-map',
      version: '1.4.0'
    },
    {
      instructions:
        '这是局域网思维导图的 MCP。除通用节点协同外，它按 CPDA 处理业务：SOP 的 C 是检查/验收标准，P 是执行计划；用户输入待办是 D，AI/WorkBuddy 负责 A。未提供房间号时先 list_maps；该工具默认每页20个房间、最多100个，只返回当前页，has_more=true 时必须原样传 next_cursor 继续，直到 false 后再判断可见房间总数。只有一张图可直接使用，多张图必须让用户确认。读取策略：用户问某个节点、直属子节点、子树、根到节点的链路、某个层级或“上下节点/上下文”时，必须先用 query_nodes，禁止为此调用 get_map；get_map 只用于用户明确要求整图概览/完整大纲。“上”用 scope=path 读取根到目标的链路；要看同级关系，先从目标返回的 parent_uid 定位父节点，再用 scope=children 读取父节点的直属子节点；“下”用 scope=children，需全部后代用 scope=subtree。query_nodes 返回 has_more=true 时必须原样传 next_cursor 继续，直到 false；同名或 fuzzy 候选只展示候选和路径，不可擅自选择。需要完整读取整间房间时只调用一次 export_room_tree，禁止用反复 query_nodes 拼整图。该工具在服务端读完快照；complete 为 true 才表示整图已读完。节点超过 500 时响应只含 export_path 和摘要，完整内容在该文件里；打不开文件时用 read_room_export 按 offset 读这份导出，不要回到 query_nodes。complete 为 false 时查看 incomplete_reason，不得声称已读完。历史版本只提供元数据和新增、修改、删除、移动计数，不提供历史脑图正文。回滚必须依次调用 list_versions、get_version，向用户展示目标版本和变更摘要并获得明确确认，再用列表返回的 currentRevision 调用 restore_version；RESTORE_CONFLICT 后必须重新查询并再次确认，禁止自动重试。附件（与网页工具栏「附件」同一套能力）：生成或拿到产物后必须调用 upload_attachment 挂到目标节点，节点会出现可点击回形针图标；禁止只把本机路径、挂载说明、「请拖到节点」写进 text/note；禁止用 update_node 的 note 代替挂载。节点超链接在 query_nodes 的 data.hyperlink 和 data.hyperlinkTitle；新增、修改或批量写入时必须原样传回这两个字段，空字符串表示清除。只复制 text/note 会丢掉超链接。upload_attachment 优先 file_path（WorkBuddy 目录或 ./output），否则 content_base64 / source_url。已有附件用 list_attachments / read_attachment；attachmentExtractedText 只是截断预览。处理任务时先 prepare_todo，按 P 执行并在对话中展示缺失信息、进度、错误和人工事项；只有全部 C 通过后才能 complete_todo。未完成的任务始终留在「待办」，完成后才移入「已完成」。不得把过程日志写入导图。一次写多个节点必须用 apply_nodes，整批一次请求、有成功修改时版本只加 1、全部失败时不增加版本；检查 outcome 和每项 items，失败依赖项暂停，核实后使用新操作 ID 补处理；不要循环 add_node、update_node 或 delete_node。AI 可以 propose_sop_improvement，但未经用户明确确认不得 apply，也不得借通用节点工具绕过确认修改 SOP。移动节点使用 move_node 的 uid 和 parent_uid，保持原 UID，禁止删除后新增模拟移动。isError 不代表肯定没有写入：outcome=unknown 或 outcomeUnknown=true 表示结果未知，使用原 operation_id、原内容和 base_revision 核实重放，禁止换新 ID 重复新增；确定拒绝或全部失败也不得声称已完成。节点评论用 list_node_comments（单个节点）或 list_comments（全图，可按未解决、@某人、时间筛选并分页）读取；用 add_comment、reply_comment、delete_comment、resolve_comment 写入，禁止用 update_node 或 apply_nodes 直接改 comments 字段。'
    }
  )

  registerLeaveTools(server, { api, z, ok, fail })
  registerApprovalTools(server, { api, z, ok, fail })

  server.tool(
    'get_performance_diagnostics',
    '只读生产性能诊断（仅超级管理员）。返回最近15分钟的MCP/HTTP/事务/浏览器性能采样，不包含节点内容或原始日志。浏览器需 perfDiagnostics=1 才有渲染采样；无采样不代表没有卡顿。',
    {
      room_key: z.string().max(100).optional().describe('按房间过滤；不填则读全进程'),
      after: z.number().int().nonnegative().optional().describe('上次返回的 cursor；只返回其后的事件'),
      since: z.number().int().nonnegative().optional().describe('采样起点 Unix 毫秒时间戳'),
      writer_after: z.number().int().nonnegative().optional().describe('MCP写入进程独立游标；不能复用服务端 after')
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ room_key, after, since, writer_after }) => {
      try {
        const params = new URLSearchParams()
        if (room_key) params.set('room', room_key)
        if (after != null) params.set('after', String(after))
        if (since != null) params.set('since', String(since))
        const backend = await api(`/api/diagnostics/performance?${params}`)
        return ok({
          ...backend,
          mcpWriter: {
            processId: process.pid,
            queue: mcpSubmitGate.status(),
            samples: mcpDiagnostics.snapshot({
              roomKey: room_key || '',
              after: writer_after,
              since
            })
          }
        })
      } catch (err) { return fail(err) }
    }
  )
  server.tool(
    'list_maps',
    '按标题筛选并分页列出当前用户可见的思维导图房间。默认每页20个，最多100个；has_more=true时将next_cursor原样传回继续读取，直到false。',
    {
      limit: z.number().int().min(1).max(100).default(20).describe('每页数量，默认20，最大100'),
      cursor: z.string().min(1).describe('上一页返回的 next_cursor').optional(),
      query: z.string().trim().describe('按房间标题筛选，不搜索节点正文').optional()
    },
    async ({ limit, cursor, query }) => {
      try {
        const params = new URLSearchParams({ limit: String(limit || 20) })
        if (cursor) params.set('cursor', cursor)
        if (query) params.set('q', query)
        const data = await api(`/api/files?${params.toString()}`)
        const nextCursor = data.nextCursor || data.next_cursor || null
        return ok({
          ...data,
          has_more: !!nextCursor,
          next_cursor: nextCursor
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'create_map',
    '新建一张导图并返回房间号、分享链接。人类用 share_url 即可加入同一房间协同。',
    {
      title: z.string().describe('根节点标题').optional(),
      room_key: z.string().describe('可选自定义房间号').optional()
    },
    async ({ title, room_key }) => {
      try {
        return ok(
          await api('/api/files', {
            method: 'POST',
            body: JSON.stringify({ title, room_key })
          })
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'get_map',
    '仅在用户明确要求整图概览或完整大纲时读取整张导图。不得用它定位某个节点、读取直属子节点/子树/路径/层级；这些场景必须使用 query_nodes。format=outline 默认最多 800 节点；format=full 超大图会截断。',
    {
      room_key: z.string().describe('房间号'),
      format: z
        .enum(['outline', 'full'])
        .describe('outline=只返回大纲；full=只返回完整树')
        .optional(),
      max_nodes: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .describe('outline/full 最大节点数，默认 800')
        .optional()
    },
    async ({ room_key, format, max_nodes }) => {
      try {
        const mode = format === 'full' ? 'full' : 'outline'
        const qs =
          mode === 'outline'
            ? `?format=outline&max_nodes=${max_nodes || 800}`
            : `?format=full&max_nodes=${max_nodes || 800}`
        return ok(
          await api(`/api/files/${encodeURIComponent(room_key)}${qs}`, {
            timeoutMs: 25000
          })
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'list_versions',
    '列出导图历史版本，只返回版本元数据和新增、修改、删除、移动计数，不返回历史脑图内容。回滚时必须使用本工具返回的 versionId 和 currentRevision。',
    {
      room_key: z.string().min(1).describe('房间号'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .describe('每页数量，默认20，最大100')
        .optional(),
      cursor: z.string().min(1).describe('上一页返回的分页游标').optional(),
      type: z
        .enum(['AUTO', 'MANUAL', 'IMPORT', 'PRE_RESTORE', 'RESTORE', 'LEGACY'])
        .describe('版本类型筛选')
        .optional(),
      created_by: z.string().min(1).describe('创建人用户ID筛选').optional(),
      from: z.string().min(1).describe('创建时间起点，ISO 8601').optional(),
      to: z.string().min(1).describe('创建时间终点，ISO 8601').optional()
    },
    async ({ room_key, limit, cursor, type, created_by, from, to }) => {
      try {
        const params = new URLSearchParams()
        if (limit != null) params.set('limit', String(limit))
        if (cursor) params.set('cursor', cursor)
        if (type) params.set('type', type)
        if (created_by) params.set('createdBy', created_by)
        if (from) params.set('from', from)
        if (to) params.set('to', to)
        const query = params.toString()
        const data = await api(
          `/api/files/${encodeURIComponent(room_key)}/versions${query ? `?${query}` : ''}`
        )
        return ok({
          ok: true,
          versions: (data.versions || []).map(historyVersion),
          nextCursor: data.nextCursor || null,
          ...historyCoverage(data)
        })
      } catch (err) {
        return historyFail(err)
      }
    }
  )

  server.tool(
    'get_version',
    '读取一个历史版本的元数据和新增、修改、删除、移动计数，不返回该版本的脑图内容。',
    {
      room_key: z.string().min(1).describe('房间号'),
      version_id: z.string().min(1).describe('list_versions 返回的版本ID')
    },
    async ({ room_key, version_id }) => {
      try {
        const data = await api(
          `/api/files/${encodeURIComponent(room_key)}/versions/${encodeURIComponent(version_id)}`
        )
        return ok({
          ok: true,
          version: historyVersion(data.version || {}),
          ...historyCoverage(data)
        })
      } catch (err) {
        return historyFail(err)
      }
    }
  )

  server.tool(
    'create_version',
    '为当前导图创建一个手动历史版本，需要房间编辑权限。返回版本元数据和变更计数，不返回脑图内容。',
    {
      room_key: z.string().min(1).describe('房间号'),
      name: z.string().trim().min(1).describe('版本名称'),
      description: z.string().describe('可选版本说明').optional()
    },
    async ({ room_key, name, description }) => {
      try {
        const data = await api(
          `/api/files/${encodeURIComponent(room_key)}/versions`,
          {
            method: 'POST',
            body: JSON.stringify({ name, description: description || '' })
          }
        )
        return ok({
          ok: true,
          version: historyVersion(data.version || {}),
          ...historyCoverage(data)
        })
      } catch (err) {
        return historyFail(err)
      }
    }
  )

  server.tool(
    'restore_version',
    '将导图回滚到指定历史版本，需要管理权限。调用前必须先用 list_versions 和 get_version 展示目标版本及变更摘要，取得用户明确确认；confirm 必须为 true。发生 RESTORE_CONFLICT 时重新查询并再次确认，禁止自动重试。',
    {
      room_key: z.string().min(1).describe('房间号'),
      version_id: z.string().min(1).describe('已向用户确认的目标版本ID'),
      expected_current_revision: z
        .number()
        .int()
        .nonnegative()
        .describe('list_versions 返回的 currentRevision'),
      confirm: z.literal(true).describe('已获得用户明确回滚确认，必须为 true')
    },
    async ({ room_key, version_id, expected_current_revision }) => {
      const idempotencyKey = randomUUID()
      try {
        const data = await api(
          `/api/files/${encodeURIComponent(room_key)}/versions/${encodeURIComponent(
            version_id
          )}/restore`,
          {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify({
              expectedCurrentRevision: expected_current_revision,
              clientId: MCP_CLIENT_ID,
              idempotencyKey
            })
          }
        )
        return ok({
          ok: true,
          fromRevision: Number(data.fromRevision),
          targetRevision:
            data.targetRevision == null ? null : Number(data.targetRevision),
          newRevision: Number(data.newRevision),
          preRestoreVersionId: data.preRestoreVersionId || '',
          restoreVersionId: data.restoreVersionId || '',
          ...historyCoverage(data)
        })
      } catch (err) {
        return historyFail(err)
      }
    }
  )

  server.tool(
    'search_nodes',
    '在指定导图里按文字搜索节点',
    {
      room_key: z.string().describe('房间号'),
      query: z.string().describe('搜索关键词')
    },
    async ({ room_key, query }) => {
      try {
        return ok(
          await api(
            `/api/files/${encodeURIComponent(
              room_key
            )}/search?q=${encodeURIComponent(query)}&limit=200`
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'query_nodes',
    '所有定向阅读的首选且必用工具：某节点、直属子节点、子树、根到目标路径或指定层级都在此读取，不得改用 get_map。selector 用 uid、精确名称或完整路径数组定位；scope 可只读节点、直属子节点、目标子树、根到目标链路，或指定绝对/相对层级。名称 fuzzy 只返回候选，不会擅自选择。超大结果请使用 next_cursor 分页继续。不会修改导图。',
    {
      room_key: z.string().describe('房间号'),
      selector: z
        .object({
          type: z.enum(['uid', 'name', 'path']).describe('定位方式'),
          value: z.string().describe('uid 或节点名称；path 类型不使用').optional(),
          segments: z.array(z.string()).describe('从根到目标的完整名称路径；仅 path 使用').optional(),
          match: z.enum(['exact', 'fuzzy']).describe('名称匹配方式，默认 exact；fuzzy 只返回候选').optional()
        })
        .describe('目标节点。scope=level 且 level_mode=absolute 时省略')
        .optional(),
      scope: z
        .enum(['self', 'children', 'subtree', 'path', 'level'])
        .describe('self=目标自身；children=直属子节点；subtree=目标及后代；path=根到目标；level=层级节点'),
      level: z.number().int().min(0).describe('scope=level 时必填；根或相对锚点为第 0 层').optional(),
      level_mode: z
        .enum(['absolute', 'relative'])
        .describe('absolute=全图层级且不传 selector；relative=目标节点下的层级')
        .optional(),
      page_size: z.number().int().min(1).max(5000).describe('每页最多节点数，默认 800').optional(),
      cursor: z.string().describe('上次返回的 next_cursor，用于继续读取').optional()
    },
    async ({ room_key, ...body }) => {
      try {
        return ok(
          await api(`/api/files/${encodeURIComponent(room_key)}/nodes/query`, {
            method: 'POST',
            body: JSON.stringify(body),
            timeoutMs: 25000
          })
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'build_sop_context',
    '按节点 UID 只读采集 SOP 所需的脑图事实上下文；完整读取路径、子节点、后代、同级节点及附件正文，不调用 get_map，不修改节点。',
    {
      room_key: z.string().min(1).describe('房间号'),
      node_uid: z.string().min(1).describe('目标节点 UID；同名节点必须使用准确 UID')
    },
    async ({ room_key, node_uid }) => {
      try {
        return ok(await buildSopContext(room_key, node_uid, api))
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'export_room_tree',
    '服务端一次性完整导出单个脑图房间。内部读取当前 room 快照并遍历全部节点，直到没有未访问子节点、没有未处理游标。不要用 query_nodes 自己翻页拼整图。默认返回 JSON。节点数不超过 500 时内联返回 room、summary、nodes、edges、references；超过 500 时写入 .tmp/mindmap-exports/<room_key>--r<revision>.json（或 ndjson）并只返回 export_path 与摘要。complete 为 true 才表示已读完；能取得节点总数时还必须 expected_node_count 等于 exported_node_count。只读，不修改导图。',
    {
      room_key: z.string().describe('房间号'),
      include_notes: z
        .boolean()
        .describe('是否导出节点备注，默认 true')
        .optional(),
      include_references: z
        .boolean()
        .describe('是否导出超链接、脑图引用和关联线，默认 true')
        .optional(),
      format: z
        .enum(['json', 'ndjson'])
        .describe('导出格式，默认 json。大房间写入文件时使用该格式')
        .optional()
    },
    async ({ room_key, include_notes, include_references, format }) => {
      try {
        return ok(
          await api(`/api/files/${encodeURIComponent(room_key)}/export-tree`, {
            method: 'POST',
            headers: { 'x-mcp-tool': 'export_room_tree' },
            body: JSON.stringify({
              include_notes,
              include_references,
              format
            }),
            timeoutMs: 60000
          })
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'read_room_export',
    '分页读取 export_room_tree 已经写好的导出文件。不会重新遍历脑图，也不会调用 query_nodes。仅当无法直接打开 export_path 时使用。has_more 为 true 时把 next_offset 作为下一次 offset，直到 false。',
    {
      room_key: z.string().describe('房间号'),
      revision: z
        .number()
        .int()
        .min(0)
        .describe('导出时的修订号；省略则读取该房间最新一份导出')
        .optional(),
      offset: z
        .number()
        .int()
        .min(0)
        .describe('节点偏移，默认 0')
        .optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .describe('本页节点数，默认 200，最大 1000')
        .optional(),
      format: z
        .enum(['json', 'ndjson'])
        .describe('要读取的导出格式；省略时优先 json')
        .optional()
    },
    async ({ room_key, revision, offset, limit, format }) => {
      try {
        const qs = new URLSearchParams()
        if (revision != null) qs.set('revision', String(revision))
        if (offset != null) qs.set('offset', String(offset))
        if (limit != null) qs.set('limit', String(limit))
        if (format) qs.set('format', format)
        const suffix = qs.toString() ? `?${qs.toString()}` : ''
        return ok(
          await api(
            `/api/files/${encodeURIComponent(room_key)}/export-tree${suffix}`,
            {
              timeoutMs: 60000,
              headers: { 'x-mcp-tool': 'read_room_export' }
            }
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'list_attachments',
    '列出导图里的附件及其解析状态，只返回元数据不返回正文。传 node_uid 只看该节点的附件。附件正文用 read_attachment 读取。不会修改导图。',
    {
      room_key: z.string().describe('房间号'),
      node_uid: z
        .string()
        .describe('只列出该节点的附件；省略则列出整张导图的附件')
        .optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .describe('最多返回条数，默认 50')
        .optional()
    },
    async ({ room_key, node_uid, limit }) => {
      try {
        const qs = new URLSearchParams()
        if (node_uid) qs.set('node_uid', node_uid)
        if (limit) qs.set('limit', String(limit))
        const suffix = qs.toString() ? `?${qs.toString()}` : ''
        return ok(
          await api(
            `/api/files/${encodeURIComponent(room_key)}/attachments${suffix}`
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'read_attachment',
    '读取附件正文（服务端已提取的文本，含 PDF/Word/Excel/PPT 和图片 OCR 结果）。节点 data 里的 attachmentExtractedText 只是截断预览，需要完整内容时必须用本工具。has_more=true 时用返回的 next_offset 继续读，直到 false。status 不是 ready 表示尚未解析成功，按 status 和 error_message 说明情况，不要凭空编造附件内容。不会修改导图。',
    {
      room_key: z.string().describe('房间号'),
      attachment_id: z
        .string()
        .describe('附件 id，来自节点 data.attachmentId、大纲附件标记或 list_attachments'),
      offset: z
        .number()
        .int()
        .min(0)
        .describe('从第几个字符开始读，默认 0；续读时传上次的 next_offset')
        .optional(),
      length: z
        .number()
        .int()
        .min(1)
        .max(20000)
        .describe('本次最多读取字符数，默认 4000')
        .optional()
    },
    async ({ room_key, attachment_id, offset, length }) => {
      try {
        const qs = new URLSearchParams()
        if (offset) qs.set('offset', String(offset))
        if (length) qs.set('limit', String(length))
        const suffix = qs.toString() ? `?${qs.toString()}` : ''
        return ok(
          await api(
            `/api/files/${encodeURIComponent(
              room_key
            )}/attachments/${encodeURIComponent(attachment_id)}/text${suffix}`,
            { timeoutMs: 25000 }
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'delete_attachment',
    '从指定节点解绑附件并通过协作操作同步修订、广播和历史。附件对象会保留，不会物理删除；如果节点已换成其他附件会返回冲突。node 支持 uid、完整标题或路径；同名节点必须改用 uid/完整路径。修改 SOP 节点前必须先获得用户确认并传 confirm_sop_change=true。',
    {
      room_key: z.string().describe('房间号'),
      node: z
        .string()
        .describe('要解绑附件的节点 uid、完整标题或路径；有同名时使用 uid'),
      attachment_id: z
        .string()
        .describe('要从节点解绑的附件 id，来自节点 data 或 list_attachments'),
      confirm_sop_change: z
        .boolean()
        .describe('目标节点属于 SOP 时，必须先获用户确认并传 true')
        .optional()
    },
    async ({ room_key, node, attachment_id, confirm_sop_change }) => {
      try {
        const baseVersion = await currentMapRevision(room_key)
        return ok(
          await deleteNodeAttachment({
            api,
            roomKey: room_key,
            node,
            attachmentId: attachment_id,
            baseVersion,
            confirmSopChange: confirm_sop_change === true
          })
        )
      } catch (err) {
        return attachmentDeleteFail(err)
      }
    }
  )

  server.tool(
    'upload_attachment',
    '与网页工具栏「附件」相同：上传文件并挂到节点，节点出现可点击回形针，人类可直接预览/下载。若节点已有附件，本次上传会替换节点当前指向：相同内容复用附件 id，不同内容生成新 id；旧文件保留在房间文件库和历史中。产物必须用本工具，禁止把路径或「请拖到节点」写进 note/text。提供 file_path（WorkBuddy 目录或仓库 output）、content_base64 或 source_url 之一。支持 txt/md/csv/pdf/docx/xlsx/html 与常见图片。只有确认节点字段已持久化后才报告成功，并返回 attachment.id 与 content_url；附件已保存但挂载失败时返回 attachment_id 供诊断，不会重复上传或删除文件。',
    {
      room_key: z.string().describe('房间号'),
      node: z
        .string()
        .describe('要挂载的节点 uid，或完整标题/路径（与 update_node 相同）'),
      file_name: z
        .string()
        .describe('文件名（含扩展名）；file_path 时可省略，默认取路径末段')
        .optional(),
      mime_type: z.string().describe('可选 MIME，缺省按扩展名推断').optional(),
      file_path: z
        .string()
        .describe(
          'MCP 进程可读的本机绝对/相对路径；与 content_base64、source_url 三选一'
        )
        .optional(),
      content_base64: z
        .string()
        .describe('文件内容的 base64；与 file_path、source_url 三选一')
        .optional(),
      source_url: z
        .string()
        .describe('可下载的 http(s) URL；与 file_path、content_base64 三选一')
        .optional(),
      confirm_sop_change: z
        .boolean()
        .describe('目标节点属于 SOP 时，必须先获用户确认并传 true')
        .optional()
    },
    async ({
      room_key,
      node,
      file_name,
      mime_type,
      file_path,
      content_base64,
      source_url,
      confirm_sop_change
    }) => {
      try {
        const resolved = await resolveAttachmentUploadInput({
          node,
          file_name,
          mime_type,
          file_path,
          content_base64,
          source_url
        })
        return ok(
          await uploadAttachmentAndMountNode({
            api,
            roomKey: room_key,
            nodeRef: resolved.nodeUid || node,
            uploadInput: resolved,
            confirmSopChange: confirm_sop_change === true,
            operationId: randomUUID()
          })
        )
      } catch (err) {
        return attachmentUploadFail(err)
      }
    }
  )

  // ---- 节点评论 ----
  const locateNodeUid = async (roomKey, node) => {
    const located = await api(
      `/api/files/${encodeURIComponent(roomKey)}/locate?uid=${encodeURIComponent(node)}`,
      { timeoutMs: 15000 }
    )
    const uid = String((located && located.uid) || '').trim()
    if (!uid) {
      const err = new Error('找不到唯一节点，请改用节点 uid 或完整路径')
      err.code = 'NODE_NOT_FOUND'
      err.statusCode = 404
      throw err
    }
    return uid
  }
  const commentPath = (roomKey, uid) =>
    `/api/files/${encodeURIComponent(roomKey)}/nodes/${encodeURIComponent(uid)}/comments`
  // 评论写入同样按房间串行排队，避免与其他 MCP 写入抢锁
  const writeComment = (roomKey, fn, extra = {}) =>
    mcpSubmitGate.run(roomKey, fn, { signal: extra && extra.signal, estimatedBytes: 4096 })
  const mentionSchema = z
    .array(
      z.object({
        user_id: z.string().describe('被 @ 成员的用户 id').optional(),
        name: z.string().min(1).describe('被 @ 成员的显示名，正文里应包含 @name')
      })
    )
    .max(20)
    .describe('@ 的成员列表')
    .optional()
  const toMentions = list =>
    Array.isArray(list) ? list.map(m => ({ userId: m.user_id || '', name: m.name })) : undefined

  server.tool(
    'list_node_comments',
    '读取单个节点的全部评论（按时间正序，已删除的不返回）以及是否已解决。node 支持 uid、完整标题或路径；同名节点用 uid。只读。',
    {
      room_key: z.string().describe('房间号'),
      node: z.string().describe('节点 uid、完整标题或路径')
    },
    async ({ room_key, node }) => {
      try {
        const uid = await locateNodeUid(room_key, node)
        return ok(await api(commentPath(room_key, uid), { timeoutMs: 20000 }))
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'list_comments',
    '在整张导图里检索评论，按时间倒序分页。可按未解决、@某人、作者、起始时间、关键词筛选。has_more=true 时原样传 next_cursor 继续。只读。',
    {
      room_key: z.string().describe('房间号'),
      unresolved: z.boolean().describe('只看未解决的讨论').optional(),
      mentioned: z.string().describe('只看 @ 了该用户（user_id 或显示名）的评论').optional(),
      author: z.string().describe('只看该 user_id 发表的评论').optional(),
      since: z.string().describe('只看该时间之后的评论，ISO 时间或毫秒时间戳').optional(),
      query: z.string().describe('评论正文关键词').optional(),
      limit: z.number().int().min(1).max(200).describe('每页条数，默认 50').optional(),
      cursor: z.string().describe('上次返回的 next_cursor').optional()
    },
    async ({ room_key, unresolved, mentioned, author, since, query, limit, cursor }) => {
      try {
        const params = new URLSearchParams()
        if (unresolved) params.set('unresolved', '1')
        if (mentioned) params.set('mentioned', mentioned)
        if (author) params.set('author', author)
        if (since) params.set('since', since)
        if (query) params.set('q', query)
        if (limit) params.set('limit', String(limit))
        if (cursor) params.set('cursor', cursor)
        const qs = params.toString()
        return ok(
          await api(`/api/files/${encodeURIComponent(room_key)}/comments${qs ? `?${qs}` : ''}`, {
            timeoutMs: 25000
          })
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'add_comment',
    '给节点发表一条评论（与网页「评论」相同，所有在线用户实时看到）。评论人是当前授权用户。content 最长 2000 字，单节点最多 500 条。可传 comment_id 作为幂等键：超时后用同一 comment_id 重试不会重复发表。',
    {
      room_key: z.string().describe('房间号'),
      node: z.string().describe('节点 uid、完整标题或路径'),
      content: z.string().min(1).max(2000).describe('评论正文'),
      mentions: mentionSchema,
      comment_id: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/).describe('可选幂等 id').optional()
    },
    async ({ room_key, node, content, mentions, comment_id }, extra = {}) => {
      try {
        const uid = await locateNodeUid(room_key, node)
        return ok(
          await writeComment(
            room_key,
            () =>
              api(commentPath(room_key, uid), {
                method: 'POST',
                timeoutMs: 30000,
                body: JSON.stringify({ id: comment_id, content, mentions: toMentions(mentions) })
              }),
            extra
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'reply_comment',
    '回复节点上的某条评论（reply_to 为被回复评论的 id，来自 list_node_comments）。回复会重新打开已解决的讨论。其余规则同 add_comment。',
    {
      room_key: z.string().describe('房间号'),
      node: z.string().describe('节点 uid、完整标题或路径'),
      reply_to: z.string().describe('被回复的评论 id'),
      content: z.string().min(1).max(2000).describe('回复正文'),
      mentions: mentionSchema,
      comment_id: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/).describe('可选幂等 id').optional()
    },
    async ({ room_key, node, reply_to, content, mentions, comment_id }, extra = {}) => {
      try {
        const uid = await locateNodeUid(room_key, node)
        return ok(
          await writeComment(
            room_key,
            () =>
              api(commentPath(room_key, uid), {
                method: 'POST',
                timeoutMs: 30000,
                body: JSON.stringify({
                  id: comment_id,
                  content,
                  reply_to,
                  mentions: toMentions(mentions)
                })
              }),
            extra
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'delete_comment',
    '删除节点上的一条评论。只能删除自己的评论；房主/管理员可删除任何人的。重复删除是幂等的。',
    {
      room_key: z.string().describe('房间号'),
      node: z.string().describe('节点 uid、完整标题或路径'),
      comment_id: z.string().describe('要删除的评论 id')
    },
    async ({ room_key, node, comment_id }, extra = {}) => {
      try {
        const uid = await locateNodeUid(room_key, node)
        return ok(
          await writeComment(
            room_key,
            () =>
              api(`${commentPath(room_key, uid)}/${encodeURIComponent(comment_id)}`, {
                method: 'DELETE',
                timeoutMs: 30000
              }),
            extra
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'resolve_comment',
    '把节点的评论讨论标记为已解决（归档），或传 resolved=false 重新打开。',
    {
      room_key: z.string().describe('房间号'),
      node: z.string().describe('节点 uid、完整标题或路径'),
      resolved: z.boolean().describe('true=解决（默认），false=重新打开').optional()
    },
    async ({ room_key, node, resolved }, extra = {}) => {
      try {
        const uid = await locateNodeUid(room_key, node)
        return ok(
          await writeComment(
            room_key,
            () =>
              api(`${commentPath(room_key, uid)}/resolve`, {
                method: 'POST',
                timeoutMs: 30000,
                body: JSON.stringify({ resolved: resolved !== false })
              }),
            extra
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'list_todos',
    '列出导图「待办」分支中的任务。默认不返回已完成任务；这不是执行工具，不会修改导图。',
    {
      room_key: z.string().describe('房间号'),
      include_completed: z
        .boolean()
        .describe('是否同时返回已完成任务，默认false')
        .optional()
    },
    async ({ room_key, include_completed }) => {
      try {
        const qs = include_completed ? '?include_completed=true' : ''
        return ok(
          await api(`/api/files/${encodeURIComponent(room_key)}/todos${qs}`)
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'prepare_todo',
    '处理任何业务待办前必须先调用。读取任务子树，匹配任意SOP目标，并返回其C检查项、P计划、版本和候选项。若match_status=needs_confirmation，先在对话中请用户选择候选SOP；若not_found，任务留在待办。该工具不会执行业务，也不会修改导图。',
    {
      room_key: z.string().describe('房间号'),
      task: z.string().describe('待办任务uid或任务标题'),
      sop: z
        .string()
        .describe('可选，用户确认后的SOP目标uid、标题或完整路径')
        .optional()
    },
    async ({ room_key, task, sop }) => {
      try {
        return ok(
          await api(
            `/api/files/${encodeURIComponent(room_key)}/todos/prepare`,
            {
              method: 'POST',
              body: JSON.stringify({ task, sop })
            }
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'complete_todo',
    'AI完成P后调用。必须逐项提交prepare_todo返回的全部C叶子检查结果；仅当全部passed=true且SOP版本未变化时，才把整棵任务从「待办」移动到「已完成」。执行过程和错误不要写进导图。',
    {
      room_key: z.string().describe('房间号'),
      task: z.string().describe('待办任务uid或任务标题'),
      sop_uid: z.string().describe('prepare_todo返回的matched_sop.uid'),
      sop_version: z.string().describe('prepare_todo返回的matched_sop.version'),
      check_results: z
        .array(
          z.object({
            check_uid: z.string().describe('C叶子检查项uid'),
            passed: z.boolean().describe('该检查项是否已经通过'),
            evidence: z
              .string()
              .describe('可选验收依据，仅用于本次校验，不写入思维导图')
              .optional()
          })
        )
        .describe('全部C叶子检查项的结果'),
      summary: z
        .string()
        .describe('可选精简完成结果；保存为任务元数据，不新增过程节点')
        .optional()
    },
    async ({ room_key, ...body }) => {
      try {
        return ok(
          await api(
            `/api/files/${encodeURIComponent(room_key)}/todos/complete`,
            {
              method: 'POST',
              body: JSON.stringify(body)
            }
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'propose_sop_improvement',
    '发现任意业务SOP的C或P存在缺失时生成结构化建议。此工具只返回建议和proposal_id，不修改思维导图；必须先把建议展示给用户确认。',
    {
      room_key: z.string().describe('房间号'),
      sop_uid: z.string().describe('要完善的SOP目标uid'),
      section: z.enum(['C', 'P']).describe('修改C检查规则或P执行计划'),
      action: z.enum(['add', 'update', 'delete']).describe('建议的修改动作'),
      node_uid: z
        .string()
        .describe('update/delete时必填，必须是对应C/P下的内容节点uid')
        .optional(),
      content: z.string().describe('add/update时的新节点内容').optional(),
      reason: z.string().describe('提出修改的业务原因')
    },
    async ({ room_key, ...body }) => {
      try {
        return ok(
          await api(
            `/api/files/${encodeURIComponent(room_key)}/sop/proposals`,
            {
              method: 'POST',
              body: JSON.stringify(body)
            }
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'apply_sop_improvement',
    '仅在用户已经明确同意propose_sop_improvement展示的建议后调用。建议内容、proposal_id和SOP版本必须一致，否则拒绝写入。',
    {
      room_key: z.string().describe('房间号'),
      proposal_id: z
        .string()
        .describe('propose_sop_improvement返回的proposal_id'),
      sop_uid: z.string().describe('建议中的sop_uid'),
      sop_version: z.string().describe('建议中的sop_version'),
      section: z.enum(['C', 'P']).describe('建议中的section'),
      action: z.enum(['add', 'update', 'delete']).describe('建议中的action'),
      node_uid: z.string().describe('建议中的node_uid').optional(),
      content: z.string().describe('建议中的content').optional(),
      reason: z.string().describe('建议中的reason'),
      user_confirmed: z
        .boolean()
        .describe('只有用户在当前对话明确同意后才能传true')
    },
    async ({ room_key, ...body }) => {
      try {
        return ok(
          await api(
            `/api/files/${encodeURIComponent(room_key)}/sop/proposals/apply`,
            {
              method: 'POST',
              body: JSON.stringify(body)
            }
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'add_node',
    '在指定节点下新增子节点。parent 可以是 uid、root，或路径如「根节点/产品」。成功只返回 uid，不返回整图。',
    {
      room_key: z.string().describe('房间号'),
      text: z.string().describe('节点文字'),
      parent: z
        .string()
        .describe('父节点 uid / root / 文字路径，默认加到根下')
        .optional(),
      note: z.string().describe('可选备注').optional(),
      hyperlink: z
        .string()
        .describe('可选超链接。复制已有节点时传 query_nodes 返回的 data.hyperlink；空字符串表示不设置')
        .optional(),
      hyperlinkTitle: z
        .string()
        .describe('可选超链接标题，对应 data.hyperlinkTitle')
        .optional(),
      confirm_sop_change: z
        .boolean()
        .describe('父节点属于SOP时，必须先获得用户确认并传true')
        .optional(),
      operation_id: z.string().uuid().describe('可选幂等请求ID，超时后使用同一ID重试').optional(),
      base_revision: z.number().int().min(0).describe('可选预期基准修订号；版本恢复冲突后不会自动换基准重试').optional()
    },
    async ({
      room_key,
      text,
      parent,
      note,
      hyperlink,
      hyperlinkTitle,
      confirm_sop_change,
      operation_id,
      base_revision
    }, extra = {}) => {
      try {
        return okWrite(
          await writeNodeMap(
            room_key,
            `/api/files/${encodeURIComponent(room_key)}/nodes`,
            'POST',
            {
              text,
              parent: parent || 'root',
              note,
              ...hyperlinkFields({ hyperlink, hyperlinkTitle }),
              confirm_sop_change
            },
            operation_id || randomUUID(),
            {
              signal: extra && extra.signal,
              baseRevision: base_revision,
              writeType: 'node.insert'
            }
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'update_node',
    '修改节点文字、备注或超链接。超链接使用 hyperlink 和 hyperlinkTitle，对应 query_nodes 的 data.hyperlink、data.hyperlinkTitle；复制或移位重建节点时必须原样写回，空字符串表示清除。禁止用 note/text 写本机文件路径或挂载说明来代替附件；挂文件必须用 upload_attachment（等同工具栏「附件」）。node 优先用 uid；也可用完整标题、部分文字或 根/父/子 路径。成功只返回 uid；如网络超时结果不确定，可用相同 operation_id 重试核验。',
    {
      room_key: z.string().describe('房间号'),
      node: z.string().describe('节点 uid 或文字路径'),
      text: z.string().describe('新文字').optional(),
      note: z.string().describe('新备注').optional(),
      hyperlink: z
        .string()
        .describe('超链接地址。不传则保持原链接；空字符串清除')
        .optional(),
      hyperlinkTitle: z
        .string()
        .describe('超链接标题。不传则保持原标题；空字符串清除')
        .optional(),
      confirm_sop_change: z
        .boolean()
        .describe('节点属于SOP时，必须先获得用户确认并传true')
        .optional(),
      operation_id: z.string().uuid().describe('可选幂等请求ID，超时后使用同一ID重试').optional(),
      base_revision: z.number().int().min(0).describe('可选预期基准修订号；版本恢复冲突后不会自动换基准重试').optional()
    },
    async ({
      room_key,
      node,
      text,
      note,
      hyperlink,
      hyperlinkTitle,
      confirm_sop_change,
      operation_id,
      base_revision
    }, extra = {}) => {
      try {
        return okWrite(
          await writeNodeMap(
            room_key,
            `/api/files/${encodeURIComponent(
              room_key
            )}/nodes/${encodeURIComponent(node)}`,
            'PATCH',
            {
              text,
              note,
              ...hyperlinkFields({ hyperlink, hyperlinkTitle }),
              confirm_sop_change
            },
            operation_id || randomUUID(),
            {
              signal: extra && extra.signal,
              baseRevision: base_revision,
              writeType: 'node.update'
            }
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'move_node',
    '把节点移动到指定父节点并可指定同级位置。必填 uid 和 parent_uid（目标父节点可为 root），不支持标题路径；保留节点 uid、子树、附件、超链接和历史关联。兼容 node/parent 别名；同一字段的两种名字不能冲突。',
    {
      room_key: z.string().describe('房间号'),
      uid: z.string().trim().min(1).describe('要移动的节点 UID；与 node 至少提供一个').optional(),
      parent_uid: z.string().trim().min(1).describe('目标父节点 UID 或 root；与 parent 至少提供一个').optional(),
      node: z.string().trim().min(1).describe('uid 的兼容别名').optional(),
      parent: z.string().trim().min(1).describe('parent_uid 的兼容别名').optional(),
      index: z.number().int().min(0).describe('目标父节点下的零基位置；省略时追加到末尾').optional(),
      confirm_sop_change: z
        .boolean()
        .describe('节点或父节点属于SOP时，必须先获得用户确认并传true')
        .optional(),
      operation_id: z.string().uuid().describe('可选幂等请求ID，超时后使用同一ID重试').optional(),
      base_revision: z.number().int().min(0).describe('可选预期基准修订号；版本恢复冲突后不会自动换基准重试').optional()
    },
    async ({ room_key, uid, parent_uid, node, parent, index, confirm_sop_change, operation_id, base_revision }, extra = {}) => {
      try {
        if ((!uid && !node) || (!parent_uid && !parent) ||
          (uid && node && uid !== node) ||
          (parent_uid && parent && parent_uid !== parent)) {
          const error = new Error('move_node 需要 uid 和 parent_uid；兼容别名不能与它们冲突')
          error.code = 'MCP_MOVE_REFERENCE_INVALID'
          error.statusCode = 400
          error.operationId = operation_id || randomUUID()
          error.writeSubmitted = false
          throw error
        }
        const nodeUid = uid || node
        const parentUid = parent_uid || parent
        return okWrite(
          await writeNodeMap(
            room_key,
            `/api/files/${encodeURIComponent(room_key)}/nodes/${encodeURIComponent(nodeUid)}`,
            'PATCH',
            {
              parent_uid: parentUid,
              ...(index == null ? {} : { index }),
              confirm_sop_change
            },
            operation_id || randomUUID(),
            {
              signal: extra && extra.signal,
              baseRevision: base_revision,
              writeType: 'node.move'
            }
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'delete_node',
    '删除节点及其全部子节点。不能删根节点。成功只返回 uid，不返回整图。',
    {
      room_key: z.string().describe('房间号'),
      node: z.string().describe('节点 uid 或文字路径'),
      confirm_sop_change: z
        .boolean()
        .describe('节点属于SOP时，必须先获得用户确认并传true')
        .optional(),
      operation_id: z.string().uuid().describe('可选幂等请求ID，超时后使用同一ID重试').optional(),
      base_revision: z.number().int().min(0).describe('可选预期基准修订号；版本恢复冲突后不会自动换基准重试').optional()
    },
    async ({ room_key, node, confirm_sop_change, operation_id, base_revision }, extra = {}) => {
      try {
        return okWrite(
          await writeNodeMap(
            room_key,
            `/api/files/${encodeURIComponent(
              room_key
            )}/nodes/${encodeURIComponent(node)}`,
            'DELETE',
            { confirm_sop_change },
            operation_id || randomUUID(),
            {
              signal: extra && extra.signal,
              baseRevision: base_revision,
              writeType: 'node.delete'
            }
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'apply_nodes',
    '一次提交最多 100 个新增、修改、移动或删除操作，成功项目共用一个版本号。operations 里的 parent 和 node 必须是 uid 或 root，不要用文字路径。同一批里新建的节点要带上 uid，后续操作用这个 uid 当 parent。失败项目会回滚到保存点并返回逐项结果；depends_on 使用此前项目的零基索引，依赖失败的项目状态为 dependency_failed。全批失败时不增加版本。仅 Direct 和房间节点表就绪时支持；不可用会明确报错，不走 legacy 批量写。单个节点使用对应单项工具。',
    {
      room_key: z.string().describe('房间号'),
      operations: z
        .array(
          z.object({
            op: z.enum(['add', 'update', 'move', 'delete']).describe('add 新增，update 修改，move 移动，delete 删除'),
            parent: z.string().describe('add 的父节点，或 move 的目标父节点 uid/root').optional(),
            node: z.string().describe('update/move/delete 的节点 uid；add 时可指定新节点 uid').optional(),
            index: z.number().int().min(0).describe('add/move 的零基同级位置；省略时追加').optional(),
            depends_on: z.array(z.number().int().min(0).max(99)).describe('依赖的此前操作零基索引；任一依赖失败则本项返回 dependency_failed').optional(),
            text: z.string().describe('节点文字').optional(),
            note: z.string().describe('备注').optional(),
            hyperlink: z
              .string()
              .describe('超链接地址。复制节点时传原 data.hyperlink；空字符串清除')
              .optional(),
            hyperlinkTitle: z
              .string()
              .describe('超链接标题，对应 data.hyperlinkTitle；空字符串清除')
              .optional(),
            confirm_sop_change: z
              .boolean()
              .describe('目标属于 SOP 时必须先获用户确认并传 true')
              .optional()
          })
        )
        .min(1)
        .max(100)
        .describe('最多 100 条，按顺序执行'),
      operation_id: z.string().uuid().describe('可选幂等请求ID，超时后使用同一ID重试并复用原逐项结果').optional(),
      base_revision: z.number().int().min(0).describe('可选预期基准修订号；版本恢复冲突后不会自动换基准重试').optional()
    },
    async ({ room_key, operations, operation_id, base_revision }, extra = {}) => {
      try {
        for (let index = 0; index < operations.length; index += 1) {
          const item = operations[index]
          const dependencies = item.depends_on || []
          if ((item.op !== 'add' && !String(item.node || '').trim()) ||
            (item.op === 'move' && !String(item.parent || '').trim()) ||
            dependencies.some(dependency => dependency >= index) ||
            new Set(dependencies).size !== dependencies.length) {
            const error = new Error(`apply_nodes 第 ${index} 项缺少必填节点引用，或 depends_on 不是互不重复的此前项下标`)
            error.code = 'BAD_BATCH_REQUEST'
            error.statusCode = 400
            error.operationId = operation_id || randomUUID()
            error.writeSubmitted = false
            throw error
          }
        }
        const ops = operations.map(item => {
          const confirm = item.confirm_sop_change
          if (item.op === 'add') {
            return {
              type: 'node.insert',
              payload: {
                parentUid: item.parent || 'root',
                ...(item.node ? { uid: item.node } : {}),
                ...(item.text != null ? { text: item.text } : {}),
                ...(item.note != null ? { note: item.note } : {}),
                ...(item.index != null ? { index: item.index } : {}),
                ...hyperlinkFields(item),
                ...(confirm != null ? { confirm_sop_change: confirm } : {})
              },
              ...(item.depends_on ? { depends_on: item.depends_on } : {})
            }
          }
          if (item.op === 'update') {
            const patch = {
              ...(item.text != null ? { text: item.text } : {}),
              ...(item.note != null ? { note: item.note } : {}),
              ...hyperlinkFields(item)
            }
            return {
              type: 'node.update',
              payload: {
                uid: item.node,
                patch,
                ...(confirm != null ? { confirm_sop_change: confirm } : {})
              },
              ...(item.depends_on ? { depends_on: item.depends_on } : {})
            }
          }
          if (item.op === 'move') {
            return {
              type: 'node.move',
              payload: {
                uid: item.node,
                parentUid: item.parent,
                ...(item.index != null ? { index: item.index } : {}),
                ...(confirm != null ? { confirm_sop_change: confirm } : {})
              },
              ...(item.depends_on ? { depends_on: item.depends_on } : {})
            }
          }
          return {
            type: 'node.delete',
            payload: {
              uid: item.node,
              ...(confirm != null ? { confirm_sop_change: confirm } : {})
            },
            ...(item.depends_on ? { depends_on: item.depends_on } : {})
          }
        })
        return okWrite(
          await writeNodeMap(
            room_key,
            `/api/maps/${encodeURIComponent(room_key)}/operations`,
            'POST',
            { type: 'node.batch', payload: { ops } },
            operation_id || randomUUID(),
            {
              signal: extra && extra.signal,
              baseRevision: base_revision,
              writeType: 'node.batch'
            }
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'replace_tree',
    '用完整树一次性覆盖整张导图。适合 AI 生成整图。tree 格式：{ data: { text }, children: [...] }',
    {
      room_key: z.string().describe('房间号'),
      title: z.string().describe('可选标题').optional(),
      tree: z.any().describe('思维导图树，{ data: { text }, children: [] }'),
      confirm_sop_change: z
        .boolean()
        .describe('覆盖含SOP的导图前，必须先获得用户确认并传true')
        .optional()
    },
    async ({ room_key, title, tree, confirm_sop_change }) => {
      try {
        return ok(
          await writeMap(
            room_key,
            `/api/files/${encodeURIComponent(room_key)}/replace`,
            'POST',
            { title, tree, confirm_sop_change }
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'rename_map',
    '重命名导图房间标题',
    {
      room_key: z.string().describe('房间号'),
      title: z.string().describe('新标题')
    },
    async ({ room_key, title }) => {
      try {
        return ok(
          await writeMap(
            room_key,
            `/api/files/${encodeURIComponent(room_key)}`,
            'PATCH',
            { title }
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'delete_map',
    '删除整张导图（房间、存储都会删）',
    {
      room_key: z.string().describe('房间号')
    },
    async ({ room_key }) => {
      try {
        return ok(
          await api(`/api/files/${encodeURIComponent(room_key)}`, {
            method: 'DELETE'
          })
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'get_share_link',
    '生成给人类打开的网页协同链接，打开后自动加入同一房间',
    {
      room_key: z.string().describe('房间号')
    },
    async ({ room_key }) => {
      try {
        const data = await api(
          `/api/files/${encodeURIComponent(room_key)}?format=meta`
        )
        return ok({
          room_key,
          title: data.title,
          share_url: data.share_url
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  return server
}

function authorized(req) {
  if (!MCP_TOKEN) return ''
  const header = String(req.headers.authorization || '')
  if (header === `Bearer ${MCP_TOKEN}`) return header
  return verifyMcpUserToken(bearerToken(header), MCP_TOKEN) ? header : null
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, mcp-session-id, MCP-Protocol-Version, x-mcp-request-id'
  )
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id')
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve(undefined)
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

async function startHttp() {
  const transports = new Map()

  const httpServer = http.createServer(async (req, res) => {
    setCors(res)
    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || 'localhost'}`
    )

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, api: API }))
      return
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }

    const httpLifecycle = createMcpHttpLifecycle(req, res, mcpDiagnostics)

    const authorization = authorized(req)
    if (authorization === null) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    try {
      const sessionId = req.headers['mcp-session-id']
      if (req.method === 'POST') {
        const body = await readJson(req)
        httpLifecycle?.markBodyParsed(body)
        let transport = sessionId ? transports.get(sessionId) : undefined
        if (!transport && isInitializeRequest(body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: id => {
              transports.set(id, transport)
            }
          })
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId)
          }
          const server = createServer(authorization)
          await server.connect(transport)
        }
        if (!transport) {
          res.writeHead(404, {
            'Content-Type': 'application/json; charset=utf-8'
          })
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: -32001,
                message: 'Session expired, please reinitialize'
              },
              id: body && body.id != null ? body.id : null
            })
          )
          return
        }
        httpLifecycle?.markTransportDispatched()
        await transport.handleRequest(req, res, body)
        return
      }

      const transport = sessionId ? transports.get(sessionId) : undefined
      if (!transport) {
        res.writeHead(400, {
          'Content-Type': 'application/json; charset=utf-8'
        })
        res.end(JSON.stringify({ error: 'invalid session' }))
        return
      }
      httpLifecycle?.markTransportDispatched()
      await transport.handleRequest(req, res)
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8'
        })
        res.end(JSON.stringify({ error: err.message || 'mcp error' }))
      }
    }
  })

  httpServer.listen(MCP_PORT, MCP_HOST, () => {
    console.error(`Mind-map MCP HTTP: http://${MCP_HOST}:${MCP_PORT}/mcp`)
    console.error(`Collab API: ${API}`)
  })
}

async function startStdio() {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

const httpMode = process.argv.includes('--http')
if (httpMode) {
  startHttp().catch(err => {
    console.error(err)
    process.exit(1)
  })
} else {
  startStdio().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
