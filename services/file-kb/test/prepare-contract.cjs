'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { withPreparedInput, cleanupPrepared } = require('../src/prepare')

test('unsupported formats bypass preprocessing', async () => {
  await withPreparedInput({filePath:'file.pdf',fileName:'file.pdf',ext:'pdf'}, async input => assert.equal(input.filePath,'file.pdf'))
})
test('temporary input is removed after callback throws, original is preserved', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'kb-prepare-test-'))
  const source=path.join(root,'original.jpg');await fs.writeFile(source,'original')
  let temporary
  try {
    await assert.rejects(withPreparedInput({filePath:source,fileName:'中文.jpg',ext:'jpg'}, async input=>{
      temporary=path.dirname(input.filePath)
      assert.equal(input.ext,'png');assert.equal(input.fileName,'中文.png')
      throw new Error('callback failure')
    },{root,runner:async (_mode,_src,dst)=>{await fs.writeFile(dst,'normalized');return {width:800}}}), /callback failure/)
    await assert.rejects(fs.stat(temporary),{code:'ENOENT'})
    assert.equal(await fs.readFile(source,'utf8'),'original')
  } finally {await fs.rm(root,{recursive:true,force:true})}
})
test('preprocessing errors and abort clean temporary directories', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'kb-prepare-test-'))
  try {
    await assert.rejects(withPreparedInput({filePath:'bad',fileName:'bad.xls',ext:'xls'},async()=>assert.fail(),{root,runner:async()=>{throw Error('corrupt workbook')}}),/corrupt workbook/)
    assert.deepEqual(await fs.readdir(root),[])
    const ctrl=new AbortController();ctrl.abort(Error('cancelled'))
    await assert.rejects(withPreparedInput({filePath:'bad',fileName:'bad.jpg',ext:'jpg',signal:ctrl.signal},async()=>assert.fail(),{root}),/cancelled/)
    await cleanupPrepared(root)
  } finally {await fs.rm(root,{recursive:true,force:true})}
})

const { createPipeline } = require('../src/pipeline')
const { EXCEL } = require('../src/limits')
test('empty OCR result stores a useful error on file, run and batch', async () => {
  const calls=[]
  const file={id:'file',ext:'jpg',raw_json_key:'raw',docling_status:'success'}
  const pool={query:async(sql,params)=>{
    calls.push({sql,params})
    if(sql.includes('select f.*'))return {rows:[file]}
    if(sql.startsWith('select id from kb.parse_runs'))return {rows:[{id:'run'}]}
    return {rows:[]}
  }}
  const queue={withFence:async(_job,fn)=>fn(pool),complete:async()=>{}}
  const pipeline=createPipeline({pool,queue,storage:{readRaw:async()=>({texts:[],tables:[],pages:{},pictures:[]})},docling:{},log:()=>{}})
  assert.equal(await pipeline.process({kind:'structure',run_id:'run',file_id:'file',lease_token:'lease'}),'failed')
  for(const fragment of ['update kb.parse_runs set status = $2','update kb.files set status = $2']){
    assert.ok(calls.some(c=>c.sql.includes(fragment)&&c.params.includes('已执行 OCR，但未识别到文字')))
  }
  assert.ok(calls.some(c=>c.sql.includes('kb.batch_items')&&c.sql.includes('error=r.error')))
})
test('XLS routes to native structure without a Docling submission', async () => {
  assert.ok(EXCEL.has('xls'))
  let raw
  const file={id:'file',ext:'xls',name:'明细.xls',storage_key:'source'}
  const pool={query:async sql=>({rows:sql.includes('select f.*')?[file]:[]})}
  let enqueued=false
  const queue={withFence:async(_job,fn)=>fn(pool),complete:async()=>{},enqueue:async()=>{enqueued=true}}
  const pipeline=createPipeline({pool,queue,storage:{resolveKey:()=>'/source',writeRaw:async(_id,json)=>{raw=json;return 'raw'}},docling:{convertFile:()=>assert.fail('XLS must not go to Docling')},log:()=>{}})
  assert.equal(await pipeline.process({kind:'parse',run_id:'run',file_id:'file'}),'parsed')
  assert.deepEqual(raw,{nativeBlocks:[]});assert.ok(enqueued)
})

test('startup cleanup removes only task directories', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'kb-prepare-test-'))
  try {
    await fs.mkdir(path.join(root,'job-stale'));await fs.writeFile(path.join(root,'job-stale','input.png'),'temporary')
    await fs.writeFile(path.join(root,'keep'),'unrelated')
    await cleanupPrepared(root)
    assert.deepEqual(await fs.readdir(root),['keep'])
  } finally {await fs.rm(root,{recursive:true,force:true})}
})
test('aborting a running preprocessing child removes the temporary input', {skip:process.platform==='win32'}, async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'kb-prepare-test-'))
  const script=path.join(root,'python-stub');const previous=process.env.KB_PYTHON
  try {
    await fs.writeFile(script,'#!/bin/sh\nexec sleep 30\n',{mode:0o700});process.env.KB_PYTHON=script
    const ctrl=new AbortController()
    const timer=setTimeout(()=>ctrl.abort(Error('cancel during preprocessing')),100)
    try {
      await assert.rejects(withPreparedInput({filePath:'unused',fileName:'x.jpg',ext:'jpg',signal:ctrl.signal},()=>assert.fail(),{root}),/cancel during preprocessing/)
    } finally {clearTimeout(timer)}
    assert.deepEqual(await fs.readdir(root),['python-stub'])
  } finally {
    if(previous===undefined)delete process.env.KB_PYTHON;else process.env.KB_PYTHON=previous
    await fs.rm(root,{recursive:true,force:true})
  }
})
