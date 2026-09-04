const { createFileSystem } = require('./engine')
const { createMemoryFileStore } = require('./memoryStore')
const { createPgFileStore } = require('./pgStore')
const { initFileSystemSchema } = require('./schema')

let engine = null

function attachFileSystem(next) {
  engine = next
  return engine
}

function getFileSystem() {
  return engine
}

function createServerFileSystem(pool, options = {}) {
  const store = pool ? createPgFileStore(pool) : createMemoryFileStore()
  const history = options.history || require('../collabHistory').getHistoryEngine()
  engine = createFileSystem({ store, history })
  return engine
}

function handleFileSystemApi(req, res, options = {}) {
  return require('./http').handleFileSystemApi(req, res, {
    ...options,
    engine: (options && options.engine) || engine
  })
}

module.exports = {
  createFileSystem,
  createMemoryFileStore,
  createPgFileStore,
  initFileSystemSchema,
  attachFileSystem,
  getFileSystem,
  createServerFileSystem,
  handleFileSystemApi
}
