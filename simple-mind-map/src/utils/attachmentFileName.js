'use strict'

const DEFAULT_MAX_LENGTH = 180
const INVALID_FILE_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g
const HAN_CHARACTER = /[\u3400-\u4dbf\u4e00-\u9fff]/

function replaceUnpairedSurrogates(value) {
  let result = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] + value[index + 1]
        index += 1
      } else {
        result += '\ufffd'
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += '\ufffd'
    } else {
      result += value[index]
    }
  }
  return result
}

function sanitizedRawName(value) {
  return replaceUnpairedSurrogates(String(value == null ? '' : value))
    .replace(INVALID_FILE_NAME_CHARS, '_')
    .trim()
    .replace(/[. ]+$/g, '')
}

function safeLength(value, maxLength) {
  let result = ''
  let length = 0
  for (const character of value) {
    const units = character.length
    if (length + units > maxLength) break
    result += character
    length += units
  }
  return result
}

function truncateLegacyAttachmentFileName(value, maxLength = DEFAULT_MAX_LENGTH) {
  const limit = Number.isSafeInteger(Number(maxLength)) && Number(maxLength) > 0
    ? Math.floor(Number(maxLength))
    : DEFAULT_MAX_LENGTH
  // This intentionally mirrors the former safeFileName implementation so a
  // re-upload can prove that a stored name was produced by its old truncation.
  return (String(value || 'file')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, limit)) || 'file'
}

function maybeDecodeEncodedHanName(value) {
  if (!/%[\da-f]{2}/i.test(value)) return value
  const hasEncodedHan = (value.match(/(?:%[\da-f]{2})+/gi) || []).some(sequence => {
    try {
      return HAN_CHARACTER.test(decodeURIComponent(sequence))
    } catch (error) {
      return false
    }
  })
  if (!hasEncodedHan) return value
  try {
    const decoded = decodeURIComponent(value)
    return decoded !== value ? decoded : value
  } catch (error) {
    // A partial percent sequence can be a literal filename. Preserve it.
    return value
  }
}

function hasEncodedHan(value) {
  return (String(value || '').match(/(?:%[\da-f]{2})+/gi) || []).some(sequence => {
    try {
      return HAN_CHARACTER.test(decodeURIComponent(sequence))
    } catch (error) {
      return false
    }
  })
}

function sanitizeAttachmentFileName(name, maxLength = DEFAULT_MAX_LENGTH) {
  const requestedLimit = Number(maxLength)
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
    ? Math.floor(requestedLimit)
    : DEFAULT_MAX_LENGTH
  const safe = sanitizedRawName(String(name == null ? '' : name)) || 'file'

  const dot = safe.lastIndexOf('.')
  const hasExtension = dot > 0 && dot < safe.length - 1
  const stem = hasExtension ? safe.slice(0, dot) : safe
  const extension = hasExtension ? safe.slice(dot) : ''

  // Preserve the extension when it fits. A pathological extension that alone
  // consumes the limit is treated as part of the stem instead of yielding an
  // empty or invalid basename.
  if (extension.length >= limit) return safeLength(safe, limit) || 'file'
  const boundedStem = safeLength(stem, limit - extension.length)
  return (boundedStem + extension).slice(0, limit) || 'file'
}

function normalizeAttachmentFileName(name, maxLength = DEFAULT_MAX_LENGTH) {
  const decoded = maybeDecodeEncodedHanName(String(name == null ? '' : name))
  return sanitizeAttachmentFileName(decoded, maxLength)
}

function detectLegacyAttachmentFileName(storedName, originalName, maxLength = DEFAULT_MAX_LENGTH) {
  const stored = String(storedName == null ? '' : storedName)
  const original = String(originalName == null ? '' : originalName)
  const normalized = normalizeAttachmentFileName(original, maxLength)
  if (!stored || stored === normalized) return null

  const directCandidate = truncateLegacyAttachmentFileName(original, maxLength)
  if (directCandidate !== normalized && stored === directCandidate) {
    return { reason: 'truncated', candidate: normalized }
  }

  let encodedName
  try {
    encodedName = encodeURIComponent(replaceUnpairedSurrogates(original))
  } catch (error) {
    encodedName = ''
  }
  if (!encodedName) return null
  // Percent escapes are case-insensitive; keep the literal filename text
  // case-sensitive so unrelated aliases are not renamed.
  const storedEscapes = stored.replace(/%[\da-f]{2}/gi, value => value.toUpperCase())
  const encodedFullCandidate = truncateLegacyAttachmentFileName(encodedName, maxLength)
  const encodedHan = hasEncodedHan(encodedName)
  if (encodedHan && encodedFullCandidate !== normalized && storedEscapes === encodedFullCandidate) {
    return {
      reason: encodedFullCandidate === encodedName ? 'encoded' : 'encoded-truncated',
      candidate: normalized
    }
  }

  // Some legacy clients stored the complete URI-encoded name. This exact
  // match may exceed the current storage limit, so check it before truncation;
  // require encoded bytes themselves to decode to Han text to avoid treating
  // ordinary `%20`-style names as corruption.
  if (encodedHan && storedEscapes === encodedName) {
    return { reason: 'encoded', candidate: normalized }
  }
  return null
}

module.exports = {
  DEFAULT_MAX_LENGTH,
  normalizeAttachmentFileName,
  sanitizeAttachmentFileName,
  truncateLegacyAttachmentFileName,
  detectLegacyAttachmentFileName
}
