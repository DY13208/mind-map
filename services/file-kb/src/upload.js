'use strict'
// Streaming multipart upload: each part is hashed (sha256) and size-checked while it is
// written to tmp; never buffered whole in memory. Then deduped and committed to CAS.
const fs = require('fs')
const crypto = require('crypto')
const Busboy = require('busboy')
const { ALLOWED, extOf, sanitizeName, checkMagic } = require('./limits')

function receiveFiles(req, { storage, maxFileBytes, maxFiles, maxBatchBytes = Infinity }) {
  return new Promise((resolve, reject) => {
    let bb
    try {
      bb = Busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { fileSize: maxFileBytes, files: maxFiles, fields: 20, fieldSize: 4096, parts: maxFiles + 20 } })
    } catch (err) { err.status = 400; err.code = 'bad_multipart'; return reject(err) }
    let totalBytes=0
    req.on('data', chunk=>{totalBytes+=chunk.length;if(totalBytes>maxBatchBytes)req.destroy(Object.assign(new Error('batch too large'),{status:413,code:'batch_too_large'}))})
    req.on('error',fail)
    const accepted = []
    const rejected = []
    const fields = {}
    const pending = []
    const entries=[]
    let failed=false
    function fail(err){
      if(failed)return
      failed=true;req.unpipe(bb)
      for(const x of entries){x.stream.destroy();x.out.destroy()}
      bb.destroy()
      Promise.allSettled(pending).then(()=>Promise.all(entries.map(x=>fs.promises.rm(x.tmp,{force:true}).catch(()=>{})))).then(()=>reject(err))
    }
    let filesLimit = false
    bb.on('field', (name, val) => { fields[name] = val })
    bb.on('filesLimit', () => { filesLimit = true })
    bb.on('file', (field, stream, info) => {
      const name = sanitizeName(info.filename)
      const ext = extOf(name)
      if (!ALLOWED[ext]) { rejected.push({ name, code: 'unsupported_type' }); stream.resume(); return }
      const tmp = storage.tmpPath()
      const hash = crypto.createHash('sha256')
      let size = 0
      let head = Buffer.alloc(0)
      let bad = null
      const out = fs.createWriteStream(tmp, { flags: 'wx' })
      entries.push({tmp,stream,out})
      const done = new Promise(res => {
        stream.on('data', chunk => {
          if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16)]).subarray(0, 16)
          size += chunk.length
          hash.update(chunk)
        })
        stream.on('limit', () => { bad = 'file_too_large' })
        stream.on('error', err=>{bad='read_failed';fail(Object.assign(err,{status:400,code:'upload_aborted'}))})
        out.on('error', err => { bad = bad || 'write_failed'; res(err) })
        out.on('finish', () => res())
        out.on('close',()=>res())
        stream.pipe(out)
      }).then(async () => {
        if(failed)return
        if (!bad && size === 0) bad = 'empty_file'
        if (!bad && !checkMagic(ext, head)) bad = 'content_type_mismatch'
        if (bad) { await fs.promises.rm(tmp, { force: true }); rejected.push({ name, code: bad }); return }
        accepted.push({ name, ext, size, sha256: hash.digest('hex'), tmp, mime: ALLOWED[ext].mime })
      })
      pending.push(done)
    })
    bb.on('error', err => { err.status = err.status||400; err.code = err.code||'bad_multipart'; fail(err) })
    bb.on('close', async () => {
      if(failed)return
      await Promise.all(pending)
      resolve({ accepted, rejected, fields, filesLimit })
    })
    req.on('aborted', () => fail(Object.assign(new Error('client aborted'), { status: 400, code: 'aborted' })))
    req.pipe(bb)
  })
}

async function cleanup(files) {
  await Promise.all(files.map(f => fs.promises.rm(f.tmp, { force: true }).catch(() => {})))
}

module.exports = { receiveFiles, cleanup }
