function historyError(code, message, status) {
  const err = new Error(message)
  err.code = code
  err.statusCode = status || 400
  return err
}

module.exports = { historyError }
