function historyError(code, message, status, options = {}) {
  const err = new Error(message)
  err.code = code
  err.statusCode = status || 400
  if (options.cause) err.cause = options.cause
  if (options.details) err.details = options.details
  return err
}

module.exports = { historyError }
