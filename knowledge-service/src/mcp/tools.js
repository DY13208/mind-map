const service = require('../service')

const TOOLS = [
  {
    name: 'list_knowledge_files',
    description: '列出当前用户有权查看的知识库文件，不含其他用户的文件。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer' },
        offset: { type: 'integer' }
      }
    }
  },
  {
    name: 'search_knowledge',
    description: '在已解析的知识库块和文件名中检索，只返回有权限的文件。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer' },
        offset: { type: 'integer' }
      },
      required: ['query']
    }
  },
  {
    name: 'query_knowledge_records',
    description: '按 kind、text、page、label 查询已保存的结构块。未知字段会被拒绝，不会编造。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        text: { type: 'string' },
        page: { type: 'integer' },
        label: { type: 'string' },
        limit: { type: 'integer' },
        offset: { type: 'integer' }
      }
    }
  },
  {
    name: 'get_knowledge_document',
    description: '读取一个知识库文件的最新解析摘要、报告和块目录。',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string' },
        limit: { type: 'integer' },
        offset: { type: 'integer' }
      },
      required: ['file_id']
    }
  },
  {
    name: 'get_knowledge_block',
    description: '读取一个结构块的文本、类型和来源。过大的原始 JSON 会被省略并标明。',
    inputSchema: {
      type: 'object',
      properties: { block_id: { type: 'string' } },
      required: ['block_id']
    }
  },
  {
    name: 'get_knowledge_source',
    description: '返回结构块在原文件中的页码、位置和解析时保存的原文片段。',
    inputSchema: {
      type: 'object',
      properties: { block_id: { type: 'string' } },
      required: ['block_id']
    }
  },
  {
    name: 'get_knowledge_import_status',
    description: '查看文件解析状态、版本、失败原因和未识别项报告。',
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string' } },
      required: ['file_id']
    }
  }
]

function toolResult(value, isError) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    isError: Boolean(isError)
  }
}

async function callTool(pool, user, config, name, args) {
  const input = args || {}
  const page = {
    limit: input.limit,
    offset: input.offset,
    maxPageSize: config.maxPageSize,
    maxResponseBytes: config.maxResponseBytes
  }
  if (name === 'list_knowledge_files') return service.listFiles(pool, user, page)
  if (name === 'search_knowledge') {
    return service.searchKnowledge(pool, user, { ...page, query: input.query })
  }
  if (name === 'query_knowledge_records') {
    return service.queryRecords(pool, user, {
      ...page,
      filters: {
        kind: input.kind,
        text: input.text,
        page: input.page,
        label: input.label
      }
    })
  }
  if (name === 'get_knowledge_document') return service.getDocument(pool, user, input.file_id, page)
  if (name === 'get_knowledge_block') {
    return service.getBlock(pool, user, input.block_id, { maxResponseBytes: config.maxResponseBytes })
  }
  if (name === 'get_knowledge_source') return service.getSource(pool, user, input.block_id)
  if (name === 'get_knowledge_import_status') return service.fileStatus(pool, user, input.file_id)
  const err = new Error(`未知工具 ${name}`)
  err.statusCode = 400
  err.code = 'UNKNOWN_TOOL'
  throw err
}

function handleRpc(message, deps) {
  const id = message && message.id
  if (!message || message.jsonrpc !== '2.0' || !message.method) {
    return { status: 400, body: { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: '无效请求' } } }
  }
  if (message.method === 'initialize') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'file-knowledge', version: '0.1.0' }
        }
      }
    }
  }
  if (!message.id) return { status: 202, body: null }
  if (message.method === 'tools/list') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: { tools: TOOLS } } }
  }
  if (message.method === 'ping') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: {} } }
  }
  if (message.method !== 'tools/call') {
    return { status: 200, body: { jsonrpc: '2.0', id, error: { code: -32601, message: '方法不存在' } } }
  }
  return callTool(
    deps.pool,
    deps.user,
    deps.config,
    message.params && message.params.name,
    (message.params && message.params.arguments) || {}
  ).then(
    value => ({ status: 200, body: { jsonrpc: '2.0', id, result: toolResult(value, false) } }),
    err => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: toolResult({ ok: false, code: err.code || 'ERROR', error: err.message }, true)
      }
    })
  )
}

module.exports = { TOOLS, handleRpc, callTool }
