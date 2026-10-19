const fs = require('fs')
const path = require('path')

function createLocalStorage(config) {
  const root = path.resolve(config.dataDir, 'objects')
  fs.mkdirSync(root, { recursive: true })

  function fullPath(key) {
    const normalized = String(key || '').replace(/\\/g, '/').replace(/^\/+/, '')
    if (!normalized.startsWith(config.objectPrefix + '/')) {
      const err = new Error('对象键不在知识库前缀内')
      err.code = 'STORAGE_PREFIX'
      throw err
    }
    if (normalized.includes('..')) {
      const err = new Error('对象键无效')
      err.code = 'STORAGE_KEY'
      throw err
    }
    const absolute = path.resolve(root, normalized)
    if (!absolute.startsWith(root + path.sep) && absolute !== root) {
      const err = new Error('对象路径越界')
      err.code = 'STORAGE_ESCAPE'
      throw err
    }
    return absolute
  }

  return {
    prefix: config.objectPrefix,
    async put(key, bytes) {
      const target = fullPath(key)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const tmp = `${target}.${process.pid}.tmp`
      fs.writeFileSync(tmp, bytes)
      fs.renameSync(tmp, target)
      return key
    },
    async read(key) {
      return fs.readFileSync(fullPath(key))
    },
    async remove(key) {
      const target = fullPath(key)
      fs.rmSync(target, { force: true })
    },
    async removeTree() {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}

function objectKey(config, ownerId, fileId, version, fileName) {
  const safeOwner = String(ownerId).replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 80)
  const safeName = path.basename(String(fileName || 'file')).replace(/[^\w.\-\u4e00-\u9fff]/g, '_')
  return `${config.objectPrefix}/${safeOwner}/${fileId}/v${version}/${safeName || 'file'}`
}

module.exports = { createLocalStorage, objectKey }
