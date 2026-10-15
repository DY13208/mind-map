'use strict'

const crypto = require('crypto')

const TRANSPORT_KEYS = new Set([
  'operationId',
  'operation_id',
  'baseVersion',
  'base_version',
  'baseRevision',
  'base_revision',
  'clientSeq',
  'client_seq',
  'actorId',
  'actor_id',
  'clientId',
  'client_id',
  '__mcpRequest',
  '__mcpResult',
  'requestDigest'
])

function stableValue(value, topLevel = false) {
  if (Array.isArray(value)) return value.map(item => stableValue(item, false))
  if (!value || typeof value !== 'object') return value
  const result = Object.create(null)
  Object.keys(value)
    .filter(
      key =>
        (key !== '__mcpRequest' && key !== '__mcpResult' && key !== 'requestDigest') &&
        (!topLevel || !TRANSPORT_KEYS.has(key))
    )
    .sort()
    .forEach(key => {
      if (value[key] !== undefined) result[key] = stableValue(value[key], false)
    })
  return result
}

function digestMcpOperation({ roomKey, principalId, type, payload }) {
  const canonical = JSON.stringify({
    roomKey: String(roomKey || ''),
    principalId: String(principalId || ''),
    type: String(type || ''),
    payload: stableValue(payload || {}, true)
  })
  return `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`
}

function operationError(code, message) {
  const error = new Error(message)
  error.code = code
  error.statusCode = 409
  return error
}

function resolveDuplicate({ existing, principalId, digest }) {
  const payload =
    existing && existing.payload && typeof existing.payload === 'object'
      ? existing.payload
      : {}
  const saved = payload.__mcpRequest
  if (!saved || saved.v !== 1 || !saved.digest || !saved.principalId) {
    throw operationError(
      'OPERATION_ID_UNVERIFIABLE',
      'operation_id 已存在但缺少可验证的 MCP 请求摘要，请换用新的 operation_id'
    )
  }
  if (
    String(saved.principalId) !== String(principalId || '') ||
    String(saved.digest) !== String(digest || '')
  ) {
    throw operationError(
      'OPERATION_ID_CONFLICT',
      'operation_id 已用于不同身份或不同请求'
    )
  }
  return { duplicate: true, existing }
}

function stripMcpRequestMetadata(payload) {
  if (Array.isArray(payload)) return payload.map(stripMcpRequestMetadata)
  if (!payload || typeof payload !== 'object') return payload
  return Object.fromEntries(
    Object.entries(payload)
      .filter(
        ([key]) =>
          key !== '__mcpRequest' &&
          key !== '__mcpResult' &&
          key !== 'requestDigest'
      )
      .map(([key, value]) => [key, stripMcpRequestMetadata(value)])
  )
}

module.exports = {
  digestMcpOperation,
  resolveDuplicate,
  stripMcpRequestMetadata
}
