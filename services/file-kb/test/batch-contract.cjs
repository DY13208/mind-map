'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {compileFilter}=require('../src/records'),{sourceOf,bboxOf}=require('../src/source'),{normalizeMappings}=require('../src/structurer/mapping'),{buildRecord}=require('../src/structurer/fields'),{loadConfig}=require('../src/config'),{retryAfterMsFor}=require('../src/errors'),{createLimiter}=require('../src/ratelimit'),{deriveBatchState}=require('../src/batches'),{previewExcel}=require('../src/structurer/excel')
test('arbitrary original field names remain parameter values, including prototype names',()=>{
  for(const field of ['耗时(h)','__proto__','constructor',"quote'); drop table kb.records; --"]){const p=[];const sql=compileFilter({field,op:'contains',value:'x'},p);assert.equal(p[0],field);assert.ok(!sql.includes(field));assert.equal(p[1],'%x%')}
  const record=buildRecord(['__proto__','constructor'],['retained','original'],{});assert.equal(JSON.parse(JSON.stringify(record.data)).__proto__,'retained')
})
test('numeric and ISO date ranges reject invalid bounds without lexical comparison',()=>{
  let p=[];assert.match(compileFilter({field:'耗时(h)',op:'range',min:2,max:10},p),/kb.try_numeric/)
  p=[];assert.match(compileFilter({field:'custom date',op:'range',min:'2026-10-19'},p),/kb.try_date/)
  assert.throws(()=>compileFilter({field:'date',op:'eq',value:'2026-02-30'},[]),e=>e.status===400)
  assert.throws(()=>compileFilter({field:'price',op:'eq',value:'NaN'},[]),e=>e.status===400)
})
test('source v2 is 1-based with explicit index and normalized bbox',()=>{
  const s=sourceOf({file_id:'x',row_index:2,column_count:61,bbox:{norm:[.1,.2,.8,.9]}})
  assert.equal(s.row,3);assert.equal(s.rowIndex,2);assert.equal(s.cell,'A3:BI3');assert.deepEqual(s.bbox,[.1,.2,.8,.9]);assert.equal(bboxOf({l:20,t:40,r:100,b:200}),null)
})
test('changed header rows drop an old full column snapshot, while explicit overrides survive',()=>{
  const preview={sheets:[{name:'S',rowCount:10,columnCount:3,regions:[{headerRows:[1],headers:['old']}]}]}
  const base={sheet:'S',headerRows:[2],dataStartRow:3,columns:[{index:0,name:'old'}]}
  assert.deepEqual(normalizeMappings([base],preview,null)[0].columns,[])
  assert.deepEqual(normalizeMappings([{...base,columnOverrides:[{index:0,name:'rename'}]}],preview,null)[0].columns,[{index:0,name:'rename'}])
  assert.throws(()=>normalizeMappings([base,base],preview,null),e=>e.status===400)
})
test('unchanged headers keep a saved custom name through an empty override list',()=>{
  const preview={sheets:[{name:'S',rowCount:10,columnCount:2,regions:[{headerRows:[2],headers:['部门','人员']}],selectedRows:[{row:2,values:['部门','人员']}]}]}
  const previous={sheets:[{sheet:'S',regions:[{confirmed:true,headerRows:[2],headers:['自定义部门','人员']}]}]}
  const again={sheet:'S',headerRows:[2],dataStartRow:3,columns:[{index:0,name:'自定义部门'},{index:1,name:'人员'}]}
  assert.deepEqual(normalizeMappings([again],preview,previous)[0].columns,[{index:0,name:'自定义部门'}])
  assert.deepEqual(normalizeMappings([{...again,columns:[],columnOverrides:[]}],preview,previous)[0].columns,[{index:0,name:'自定义部门'}])
  assert.deepEqual(normalizeMappings([{...again,columnOverrides:[{index:0,name:'新名称'}]}],preview,previous)[0].columns,[{index:0,name:'新名称'}])
})
test('429 wait depends on the limiter code and the per-minute window',()=>{
  assert.equal(retryAfterMsFor('queue_full'),20000)
  assert.equal(retryAfterMsFor('too_many_concurrent_uploads'),3000)
  assert.equal(retryAfterMsFor('rate_limited',2500),2500)
  assert.equal(retryAfterMsFor('other'),10000)
  let now=0
  const limiter=createLimiter({perMinute:1,now:()=>now})
  assert.equal(limiter.take('u',1),true)
  assert.equal(limiter.take('u',1),false)
  assert.equal(limiter.retryAfterMs('u'),60000)
  now=25000
  assert.equal(limiter.retryAfterMs('u'),35000)
})
test('seal does not require every planned file before the batch can finish',()=>{
  const counts={waiting:0,processing:0,done:1,partial:0,failed:0,cancelled:0}
  const early=deriveBatchState({control:'running',sealed_at:new Date(),expected_count:3},counts)
  assert.equal(early.state,'partial')
  assert.equal(early.notUploaded,2)
  const full=deriveBatchState({control:'running',sealed_at:new Date(),expected_count:1},counts)
  assert.equal(full.state,'done')
  const mixed=deriveBatchState({control:'cancelled',sealed_at:new Date(),expected_count:3},{waiting:0,processing:0,done:1,partial:0,failed:0,cancelled:2})
  assert.equal(mixed.state,'cancelled')
})
test('excel preview returns one sheet window without the surrounding rows',async()=>{
  const fs=require('fs'),os=require('os'),path=require('path'),ExcelJS=require('exceljs')
  const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('Page')
  for(let n=1;n<=30;n++)ws.addRow(['r'+n,n])
  const file=path.join(os.tmpdir(),'kb-page-'+require('crypto').randomUUID()+'.xlsx')
  await wb.xlsx.writeFile(file)
  try{
    const page=await previewExcel(file,{sheet:'Page',fromRow:20,limit:5,maxCols:5})
    assert.deepEqual(page.sheets[0].preview.map(r=>r.row),[20,21,22,23,24])
    assert.equal(page.sheets[0].preview[0].values[0],'r20')
    assert.equal(page.sheets[0].rowCount,30)
    await assert.rejects(previewExcel(file,{sheet:'Missing',fromRow:1,limit:1}),e=>e.status===404)
  }finally{await fs.promises.rm(file,{force:true})}
})
test('format limits are bounded and global concurrency stays at two by default',()=>{
  assert.equal(loadConfig({}).concurrency,2)
  assert.deepEqual(loadConfig({KB_FORMAT_CONCURRENCY:'{"pdf":1,"xlsx":2}'}).formatConcurrency,{pdf:1,xlsx:2})
  assert.throws(()=>loadConfig({KB_FORMAT_CONCURRENCY:'{"pdf":99}'}))
})
test('sparse XLSX XML with missing blank-row elements keeps two table boundaries',async()=>{
  const fs=require('fs'),os=require('os'),path=require('path'),ExcelJS=require('exceljs'),JSZip=require('jszip')
  const {structureExcel}=require('../src/structurer/excel')
  const w=new ExcelJS.Workbook(),s=w.addWorksheet('Sparse')
  s.getRow(1).values=['SKU','Price'];s.getRow(2).values=['A',2]
  s.getRow(5).values=['SKU','Price'];s.getRow(6).values=['B',10]
  const zip=await JSZip.loadAsync(await w.xlsx.writeBuffer()),entry='xl/worksheets/sheet1.xml'
  let xml=await zip.file(entry).async('string')
  xml=xml.replace(/<row\b[^>]*\br="[34]"[^>]*\/>/g,'').replace(/<row\b[^>]*\br="[34]"[^>]*>[\s\S]*?<\/row>/g,'')
  zip.file(entry,xml)
  const file=path.join(os.tmpdir(),'kb-sparse-'+require('crypto').randomUUID()+'.xlsx')
  try{
    await fs.promises.writeFile(file,await zip.generateAsync({type:'nodebuffer'}))
    for(let i=0;i<3;i++){const rows=[];const r=await structureExcel(file,{onBatch:async b=>rows.push(...b)});assert.equal(r.sheets[0].regions.length,2);assert.deepEqual(rows.map(x=>x.row_index),[1,5]);assert.deepEqual(rows.map(x=>x.table_index),[0,1])}
  }finally{await fs.promises.rm(file,{force:true})}
})
