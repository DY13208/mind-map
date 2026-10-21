// Local-only fixture server for the production preview components. It performs
// no uploads or writes to the collaboration server or the user's database.
const fs = require('fs')
const path = require('path')
const http = require('http')
const esbuild = require('esbuild')
const compiler = require('vue-template-compiler')
const less = require('less')
const JSZip = require('jszip')
const XLSX = require('xlsx')
const root = path.resolve(__dirname, '../..')
const { PDFDocument, StandardFonts, rgb } = require(path.join(root, 'simple-mind-map/node_modules/pdf-lib'))
const assets = require('./attachmentPreviewAssets')()
const requests = []

async function fixtures() {
  const markdown = '# 公司模型\n\n> 由公司模型导图转换整理。\n> 保留原脑图的工作表、节点层级、节点文本、备注与标签。\n> 共 5 个工作表，5790 个主题节点。\n\n## 目录\n\n1. 公司\n2. 人事\n3. 法务\n4. 财务\n5. AI\n\n' +
    ['公司', '人事', '法务', '财务', 'AI'].map((name, index) => '## ' + (index + 1) + '. ' + name + '\n\n**根主题：** ' + name + '模型\n\n### 知识\n\n- CPD 规则\n  - 指 Check、Plan、Do 的循环，是一种工作方法论。\n  - 运行方式：检查、规划、执行。\n\n| 配置项 | 建议值 |\n| --- | --- |\n| 内容显示 | 按滚动位置逐步加载 |\n| 文件预览 | 通用附件组件 |\n\n```javascript\nconst preview = { lazy: true, type: "document" };\nconsole.log(preview);\n```\n\n' + Array.from({ length: 90 }, (_, n) => '### ' + name + ' · 说明 ' + (n + 1) + '\n\n根据当前业务目标进行检查与规划，明确输入、输出和验收标准。\n\n').join('')).join('')
  const workbook = XLSX.utils.book_new()
  for (const sheet of ['财务数据', '项目预算', '人员配置']) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['月份', '收入（元）', '支出（元）', '利润（元）', '增长率', '备注'],
      ...Array.from({ length: 2500 }, (_, index) => [(index + 1) + '月', 120000 + index * 100, 80000, 40000 + index * 100, '12%', '测试数据'])
    ]), sheet)
  }
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>')
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="image1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.png"/></Relationships>')
  const image = fs.readFileSync(path.join(root, 'web/src/assets/img/logo2.png'))
  zip.file('word/media/image.png', image)
  zip.file('word/styles.xml', '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style></w:styles>')
  const paragraph = text => '<w:p><w:r><w:t>' + text + '</w:t></w:r></w:p>'
  const table = '<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single"/><w:left w:val="single"/><w:bottom w:val="single"/><w:right w:val="single"/><w:insideH w:val="single"/><w:insideV w:val="single"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="3500"/><w:gridCol w:w="3500"/></w:tblGrid>' + ['项目,验收标准', '文件预览,可以正常打开', '协同编辑,保持原有行为'].map(line => '<w:tr>' + line.split(',').map(value => '<w:tc>' + paragraph(value) + '</w:tc>').join('') + '</w:tr>').join('') + '</w:tbl>'
  const drawing = '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1200000" cy="1200000"/><wp:docPr id="1" name="项目标识"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="logo"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="image1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1200000" cy="1200000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>项目方案</w:t></w:r></w:p>' + drawing + table +
    Array.from({ length: 180 }, (_, index) => (index % 30 === 0 ? '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>' + (index / 30 + 1) + '. 项目章节</w:t></w:r></w:p>' : '') + paragraph('文档段落 ' + (index + 1) + '：明确项目背景、需求分析和实施计划。保留基本段落、标题、表格与图片排版。')).join('') +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000"/></w:sectPr></w:body></w:document>')
  const archive = new JSZip()
  for (let i = 0; i < 260; i++) archive.file('资料/文件' + i + '.txt', 'archive content ' + i)
  const pptx = new JSZip()
  pptx.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' + [1,2,3].map(i => '<Override PartName="/ppt/slides/slide'+i+'.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>').join('') + '</Types>')
  pptx.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>')
  pptx.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>'+[1,2,3].map(i => '<p:sldId id="'+(255+i)+'" r:id="rId'+i+'"/>').join('')+'</p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>')
  pptx.file('ppt/_rels/presentation.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+[1,2,3].map(i => '<Relationship Id="rId'+i+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide'+i+'.xml"/>').join('')+'</Relationships>')
  for (const i of [1,2,3]) {
    pptx.file('ppt/slides/slide'+i+'.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="EAF2FF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="7000000" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="3200" b="1"><a:solidFill><a:srgbClr val="2455AA"/></a:solidFill></a:rPr><a:t>项目方案 · 第 '+i+' 页</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr id="3" name="Logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="image1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="914400" y="2286000"/><a:ext cx="1200000" cy="1200000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld></p:sld>')
    pptx.file('ppt/slides/_rels/slide'+i+'.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo.png"/></Relationships>')
  }
  pptx.file('ppt/media/logo.png', image)
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let index = 1; index <= 24; index++) {
    const page = pdf.addPage([595, 842])
    page.drawText('PROJECT BRIEF', { x: 50, y: 760, size: 30, font, color: rgb(.1, .2, .35) })
    page.drawText('Page ' + index + ' / 24', { x: 50, y: 710, size: 16, font })
    for (let row = 0; row < 22; row++) page.drawText('Preview content ' + (row + 1) + ': scope, delivery, quality and acceptance.', { x: 50, y: 660 - row * 23, size: 12, font })
  }
  const make = (id, fileName, buffer, extra = {}) => ({ id, fileName, buffer, byteSize: buffer.length, status: 'ready', mimeType: '', updatedAt: '2026-10-14T03:00:00Z', ...extra })
  const csv = '编号,姓名,备注\r\n00123,张三,"包含,逗号"\r\n00007,李四,"第一行\n第二行"\r\n'
  const wav = Buffer.alloc(44 + 16000)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(16000, 40)
  return {
    csv: make('csv', '中文数据.csv', Buffer.from('\ufeff' + csv), { mimeType: 'text/csv' }),
    csvGbk: make('csvGbk', 'GBK数据.csv', require('iconv-lite').encode(csv, 'gb18030'), { mimeType: 'text/csv' }),
    tsv: make('tsv', '制表符数据.tsv', Buffer.from('编号\t名称\t备注\n00123\t中文\t"含\t制表符"'), { mimeType: 'text/tab-separated-values' }),
    xls: make('xls', '旧版表格.xls', XLSX.write(workbook, { type: 'buffer', bookType: 'xls' })),
    xlsb: make('xlsb', '二进制表格.xlsb', XLSX.write(workbook, { type: 'buffer', bookType: 'xlsb' })),
    ods: make('ods', '开放文档表格.ods', XLSX.write(workbook, { type: 'buffer', bookType: 'ods', compression: true })),
    emptyCsv: make('emptyCsv', '空表格.csv', Buffer.alloc(0), { mimeType: 'text/csv' }),
    audio: make('audio', '音频示例.wav', wav, { mimeType: 'audio/wav' }),
    badVideo: make('badVideo', '不支持的编码.mp4', Buffer.from('not a video'), { mimeType: 'video/mp4' }),
    markdown: make('markdown', '公司模型_整理版.md', Buffer.from(markdown), { mimeType: 'text/markdown' }),
    pdf: make('pdf', '项目说明书.pdf', Buffer.from(await pdf.save()), { mimeType: 'application/pdf' }),
    word: make('word', '项目方案.docx', await zip.generateAsync({ type: 'nodebuffer' }), {mimeType:'text/markdown'}),
    excel: make('excel', '财务数据.xlsx', XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), {mimeType:'text/markdown'}),
    image: make('image', '项目图片.png', image, { mimeType: 'image/png', status: 'failed', errorMessage: '图片 OCR 服务未配置' }),
    text: make('text', '日志记录.txt', Buffer.from(Array.from({ length: 35000 }, (_, i) => '2026-10-14 10:00:00 [INFO] 日志记录 ' + i + '\n').join(''))),
    code: make('code', 'app.js', Buffer.from(Array.from({ length: 15000 }, (_, i) => 'const value' + i + ' = { ready: true }; // async preview\n').join(''))),
    archive: make('archive', '项目资料.zip', await archive.generateAsync({type:'nodebuffer'}), {mimeType:'text/markdown'}),
    presentation: make('presentation', '项目汇报.pptx', await pptx.generateAsync({type:'nodebuffer'}), {mimeType:'text/markdown',extractedText:'这段提取文字不应显示为预览'}),
    html: make('html', '项目网页.html', Buffer.from('<!doctype html><meta charset="utf-8"><h1>原始 HTML 页面</h1><table><tr><td>保留网页排版</td></tr></table>'), {mimeType:'text/html'}),
    unsupported: make('unsupported', '未知格式.bin', Buffer.from('unsupported'), {mimeType:'text/markdown'}),
    large: make('large', '大型文档.docx', Buffer.from('large'), { byteSize: 100 * 1024 * 1024 }),
    slow: make('slow', '慢速文件.txt', Buffer.from('slow')),
    error: make('error', '无权访问.txt', Buffer.from('denied'))
  }
}
async function main() {
  const files = await fixtures()
  const meta = Object.fromEntries(Object.entries(files).map(([key, file]) => {
    const item = { ...file }
    delete item.buffer
    return [key, item]
  }))
  let compiled
  const context = await esbuild.context({
    stdin: { resolveDir: root, contents:
      "import Vue from './web/node_modules/vue/dist/vue.esm.js'; import ElementUI from './web/node_modules/element-ui'; import './web/node_modules/element-ui/lib/theme-chalk/index.css'; import MindMap from './simple-mind-map/index.js'; import ImgAdjust from './simple-mind-map/src/plugins/NodeImgAdjust.js'; import VueViewer from './web/node_modules/v-viewer'; import './web/node_modules/viewerjs/dist/viewer.css'; import ImgPreview from './web/src/pages/Edit/components/NodeImgPreview.vue'; import Preview from './web/src/pages/Edit/components/NodeAttachmentPreview.vue';" +
      "Vue.use(ElementUI); Vue.use(VueViewer); MindMap.usePlugin(ImgAdjust); const bus=new Vue(); Vue.prototype.$bus=bus; Vue.prototype.$route={query:{room:'preview-fixtures'}}; window.__MIND_MAP_RUNTIME__={gateway:true,publicPath:'/'};window.externalPublicPath='/';" +
      'const files=' + JSON.stringify(meta) + ';' +
      "window.previewHost=new Vue({render:h=>h(Preview)}).$mount('#preview');window.map=new MindMap({el:document.querySelector('#map'),data:{data:{uid:'root',text:'附件预览 · 本地验证'},children:[{data:{uid:'inline-image',text:'插入图片',image:" + JSON.stringify('data:image/png;base64,' + fs.readFileSync(path.join(root,'web/src/assets/img/logo2.png')).toString('base64')) + ",imageSize:{width:64,height:64,custom:true}},children:[]},...Object.values(files).map(file=>({data:{uid:file.id,text:file.fileName,attachmentId:file.id,attachmentName:file.fileName,attachmentMimeType:file.mimeType,attachmentStatus:file.status,attachmentError:file.errorMessage||''},children:[]}))]}});new Vue({render:h=>h(ImgPreview,{props:{mindMap:map}})}).$mount(document.body.appendChild(document.createElement('div')));map.on('node_attachmentClick',node=>bus.$emit('node_attachmentClick',node));" +
      "Object.values(files).forEach(file=>{const button=document.createElement('button');button.textContent=file.fileName;button.onclick=()=>bus.$emit('node_attachmentClick',{getData:()=>({attachmentId:file.id,attachmentName:file.fileName,attachmentMimeType:file.mimeType,attachmentStatus:file.status})});document.querySelector('#fixtures').appendChild(button)});setTimeout(()=>map.view.fit(),100);"
    },
    bundle: true, write: false, outdir: 'demo', platform: 'browser',
    define: { 'process.env.NODE_ENV': '"test"' },
    alias: { 'simple-mind-map': path.join(root, 'simple-mind-map'), '@': path.join(root, 'web/src'), 'docx-preview': path.join(root, 'web/node_modules/docx-preview/dist/docx-preview.js') },
    nodePaths: [path.join(root, 'web/node_modules')], loader: { '.ttf': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' },
    plugins: [{ name: 'preview-components', setup(build) {
      build.onEnd(result => { if (!result.errors.length) compiled = result })
      build.onLoad({ filter: /web\/src\/utils\/fileApi\.js$/ }, () => ({ contents: 'export async function apiRequest(url, options) { const res=await fetch(url, options);const value=await res.json();if(!res.ok)throw new Error(value.error);return value }', loader: 'js' }))
      build.onLoad({ filter: /\.less$/ }, async args => ({ contents: (await less.render(fs.readFileSync(args.path, 'utf8'))).css, loader: 'css' }))
      build.onLoad({ filter: /\.vue$/ }, args => {
        const parsed = compiler.parseComponent(fs.readFileSync(args.path, 'utf8'))
        return { contents: parsed.script.content.replace('export default', 'const component=') + '\ncomponent.template=' + JSON.stringify(parsed.template.content) + ';export default component', resolveDir: path.dirname(args.path), loader: 'js' }
      })
    } }]
  })
  await context.rebuild()
  await context.watch()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/demo.js' || url.pathname === '/demo.css') {
      const suffix = url.pathname.endsWith('.css') ? '.css' : '.js'
      res.setHeader('Content-Type', suffix === '.css' ? 'text/css' : 'application/javascript')
      res.end(compiled.outputFiles.find(file => file.path.endsWith(suffix)).contents); return
    }
    if (url.pathname.startsWith('/attachment-preview/')) {
      const relative = url.pathname.slice('/attachment-preview/'.length)
      const file = path.resolve(assets, relative)
      if (!file.startsWith(assets + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return }
      res.setHeader('Content-Type', /\.m?js$/.test(file) ? 'application/javascript' : 'application/octet-stream')
      fs.createReadStream(file).pipe(res); return
    }
    if (url.pathname === '/requests') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(requests)); return }
    const hit = url.pathname.match(/\/attachments\/([^/]+)(\/content)?$/)
    if (hit) {
      const file = files[hit[1]]
      const log = { id: hit[1], content: !!hit[2], query: url.search, closed: false, sent: 0 }
      requests.push(log); res.on('close', () => { log.closed = true })
      res.setHeader('Content-Type', 'application/json')
      if (!file || hit[1] === 'error') { res.writeHead(403); res.end(JSON.stringify({ error: '无权访问此附件' })); return }
      if (!hit[2]) { res.end(JSON.stringify({ attachment: meta[file.id] })); return }
      res.setHeader('Content-Type', file.mimeType || 'application/octet-stream')
      if (url.searchParams.has('download')) res.setHeader('Content-Disposition', 'attachment; filename="original.' + file.fileName.split('.').pop() + '"')
      if (file.id === 'slow') {
        const timer = setInterval(() => { res.write('slow preview content\n'); log.sent += 21 }, 100)
        res.on('close', () => clearInterval(timer)); return
      }
      res.setHeader('Content-Length', file.buffer.length)
      let offset = 0
      const send = () => {
        if (res.destroyed) return
        const chunk = file.buffer.subarray(offset, offset + 16384)
        offset += chunk.length; log.sent += chunk.length
        if (chunk.length) res.write(chunk)
        if (offset >= file.buffer.length) res.end()
        else setTimeout(send, 6)
      }
      send(); return
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>通用附件预览 · 本地验证</title><link rel="stylesheet" href="/demo.css"><style>body{margin:0;font-family:system-ui;background:#f5f7fb}#fixtures{display:flex;gap:8px;flex-wrap:wrap;padding:16px}#fixtures button{padding:8px 12px;border:1px solid #dce4ef;background:white;border-radius:6px;color:#344155;cursor:pointer}#map{height:82vh;width:100vw}</style><nav id="fixtures" aria-label="测试附件"></nav><div id="map"></div><div id="preview"></div><script src="/demo.js"></script>')
  })
  await new Promise(resolve => server.listen(Number(process.env.PREVIEW_PORT || 4321), '127.0.0.1', resolve))
  console.log('Attachment preview demo: http://127.0.0.1:' + server.address().port)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
