'use strict'

const { resolveDuplicate } = require('./mcpOperationIdentity')

const RECEIPT_MIGRATION = '012_mcp_terminal_receipts.up.sql'

function missingSchemaError(cause) {
  if (!cause || !['42P01', '42703'].includes(String(cause.code || ''))) return null
  const error = new Error(
    `MCP 写入幂等回执不可用，请先应用数据库迁移 ${RECEIPT_MIGRATION}`
  )
  error.code = 'MCP_OPERATION_RECEIPT_SCHEMA_MISSING'
  error.statusCode = 503
  error.cause = cause
  return error
}

function resultForReceipt(receipt, mcpRequest) {
  resolveDuplicate({
    existing: {
      operation_id: receipt && receipt.operation_id,
      payload: {
        __mcpRequest: {
          v: 1,
          principalId: receipt && receipt.principal_id,
          digest: receipt && receipt.request_digest
        }
      }
    },
    principalId: mcpRequest && mcpRequest.principalId,
    digest: mcpRequest && mcpRequest.digest
  })
  if (!receipt.result || typeof receipt.result !== 'object' || Array.isArray(receipt.result)) {
    const error = new Error('operation_id 的 MCP 批量终态回执格式无效')
    error.code = 'OPERATION_ID_UNVERIFIABLE'
    error.statusCode = 409
    throw error
  }
  const currentRevision = Number(receipt.current_revision)
  if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) {
    const error = new Error('operation_id 的 MCP 批量终态回执版本无效')
    error.code = 'OPERATION_ID_UNVERIFIABLE'
    error.statusCode = 409
    throw error
  }
  return { result: receipt.result, currentRevision }
}

module.exports = {
  RECEIPT_MIGRATION,
  missingSchemaError,
  resultForReceipt
}
