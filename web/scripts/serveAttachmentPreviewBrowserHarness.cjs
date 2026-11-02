const fs = require('fs')
const http = require('http')
const path = require('path')
const babel = require('@babel/core')
const compiler = require('vue-template-compiler')
const less = require('less')

const root = path.resolve(__dirname, '..')
const componentFile = path.join(root, 'src/pages/Edit/components/NodeAttachmentPreview.vue')
const component = compiler.parseComponent(fs.readFileSync(componentFile, 'utf8'))
const template = compiler.compileToFunctions(component.template.content)
const rootTemplate = compiler.compileToFunctions(`<div id="browserHarness"><nav class="testControls"><button @click="openAttachment('pdf')">打开 PDF</button><button @click="openAttachment('png')">打开 PNG</button><button @click="openAttachment('archive')">下载压缩包</button><button @click="openAttachment('denied')">打开受限原件</button></nav><NodeAttachmentPreview ref="viewer" /></div>`)
const componentCode = babel.transformSync(component.script.content, {
  babelrc: false,
  configFile: false,
  plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
}).code
const css = less.render(fs.readFileSync(path.join(root, 'src/style/attachment-preview.less'), 'utf8')).then(result => result.css)

function jsString(value) { return JSON.stringify(value) }

async function pageHtml() {
  const styles = await css
  const render = `Component.render = new Function('return (' + ${jsString(template.render.toString())} + ')')();`
  const staticRenders = template.staticRenderFns.map(fn => `new Function('return (' + ${jsString(fn.toString())} + ')')()`).join(',')
  const rootRender = `new Function('return (' + ${jsString(rootTemplate.render.toString())} + ')')()`
  const rootStaticRenders = rootTemplate.staticRenderFns.map(fn => `new Function('return (' + ${jsString(fn.toString())} + ')')()`).join(',')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>附件预览浏览器验收</title><style>${styles}
    body{margin:0;background:#eef2f7;font-family:Arial,sans-serif}#app{padding:16px}.testControls{display:flex;gap:8px;margin-bottom:12px}.testControls button{padding:8px 12px}
    .fixturePdf,.fixtureImage{flex:1;display:grid;place-items:center;background:#fff;color:#344054;font-size:18px}.fixtureImage img{max-width:90%;max-height:90%;object-fit:contain}
  </style></head><body><div id="app"></div><script src="/vue.runtime.min.js"></script><script>
  const fixtures = {
    pdf:{id:'att-pdf',fileName:'扫描件.pdf',mimeType:'application/pdf',status:'failed',errorMessage:'PDF 未提取到文字（可能是扫描件，需 OCR）',byteSize:1024},
    png:{id:'att-png',fileName:'图片.png',mimeType:'image/png',status:'failed',errorMessage:'图片 OCR 服务未配置',byteSize:512},
    archive:{id:'att-zip',fileName:'资料.tar.gz',mimeType:'application/gzip',status:'ready',errorMessage:'',byteSize:18},
    denied:{id:'att-denied',fileName:'受限.pdf',mimeType:'application/pdf',status:'failed',errorMessage:'PDF 未提取到文字',byteSize:512}
  };
  window.__downloadCount=0;
  const statusOf=d=>String(d&&(d.attachmentStatus||d.status)||'').toLowerCase();
  const canOriginal=d=>!!(d&&(d.attachmentId||d.id||d.attachmentUrl))&&(/\\.(png|jpe?g|webp|gif|pdf)$/i.test(d.attachmentName||d.fileName||'')||/^(image\\/(png|jpe?g|webp|gif)|application\\/pdf)$/i.test(d.attachmentMimeType||d.mimeType||''));
  const errorActive=d=>statusOf(d)==='failed'&&!d.attachmentErrorIgnored;
  const errorText=d=>String(d&&(d.attachmentError||d.errorMessage)||'').trim();
  const mocks={
    '@/utils/roomLocation':{roomFromLocation:()=> 'browser-test'},
    '@/utils/nodeAttachmentApi':{
      getNodeAttachment:async(room,id)=>{if(id==='att-denied'){const e=new Error('403 Forbidden');e.statusCode=403;throw e}return {attachment:fixtures[Object.keys(fixtures).find(k=>fixtures[k].id===id)]}},
      nodeAttachmentContentUrl:(room,id,options={})=>'/download/'+id+(options.download?'?download=1':'')
    },
    '@/utils/nodeAttachmentPreview':{attachmentPreviewKind:name=>String(name).endsWith('.pdf')?'pdf':String(name).endsWith('.png')?'image':String(name).endsWith('.tar.gz')?'archive':'unsupported',isHtmlAttachment:()=>false,attachmentBusyMessage:()=> '附件处理中'},
    '@/utils/attachmentProgressiveText':{formatPreviewBytes:n=>String(n||0)+' B'},
    'simple-mind-map/src/svg/attachmentFileIcons':{getAttachmentFileIconSvg:()=>'<span aria-hidden="true">FILE</span>'},
    'simple-mind-map/src/utils/attachmentIconState':{isAttachmentErrorActive:errorActive,attachmentErrorText:errorText,canPreviewOriginalAttachment:canOriginal},
    '@/style/attachment-preview.less':{}
  };
  const module={exports:{}};
  new Function('require','module','exports',${jsString(componentCode)})(name=>{if(!(name in mocks))throw new Error('Unexpected module '+name);return mocks[name]},module,module.exports);
  const Component=module.exports.default;
  ${render}
  Component.staticRenderFns=[${staticRenders}];
  Component._previewModuleLoadTimeoutMs=3000;
  Vue.prototype.$route={query:{room:'browser-test'}};
  Vue.prototype.$message={info(){},warning(){},success(){},error(){}};
  Vue.prototype.$bus={$on(){},$off(){},$emit(){}};
  Vue.component('el-dialog',{props:['visible','title','customClass'],render(h){if(!this.visible)return h();return h('section',{class:['el-dialog',this.customClass],attrs:{role:'dialog','aria-label':this.title||'附件预览'}},[this.$slots.title?h('header',{class:'el-dialog__header'},this.$slots.title):h('header',{class:'el-dialog__header'},[h('h2',this.title||'附件预览')]),h('div',{class:'el-dialog__body'},this.$slots.default||[]),this.$slots.footer?h('footer',{class:'el-dialog__footer'},this.$slots.footer):null])}});
  Vue.component('el-button',{props:['size','type','icon','ariaLabel'],render(h){return h('button',{attrs:{'aria-label':this.ariaLabel||null},class:['el-button',this.type?'el-button--'+this.type:''],on:this.$listeners},this.$slots.default||[])}});
  const vm=new Vue({components:{NodeAttachmentPreview:Component},methods:{openAttachment(key){const data=fixtures[key];this.$refs.viewer.onAttachmentClick({getData:()=>({uid:'n-'+key,attachmentId:data.id,attachmentName:data.fileName,attachmentMimeType:data.mimeType,attachmentStatus:data.status,attachmentError:data.errorMessage})})},},render:${rootRender}}).$mount('#app');
  vm.$options.staticRenderFns=[${rootStaticRenders}];
  vm.$refs.viewer._previewModuleLoaders={
    AttachmentPdfPreview:()=>Promise.resolve({render(h){return h('div',{class:'fixturePdf',attrs:{'data-testid':'original-pdf-preview'}},['PDF 原文件预览'])}}),
    AttachmentImagePreview:()=>Promise.resolve({render(h){return h('div',{class:'fixtureImage',attrs:{'data-testid':'original-image-preview'}},[h('img',{attrs:{src:'/fixture.png',alt:'PNG 原文件预览'}})])}})
  };
  window.__viewer=vm.$refs.viewer;
  </script></body></html>`
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l5sAAAAASUVORK5CYII=', 'base64')
const archiveBytes = Buffer.from('archive-fixture-original-bytes')
const server = http.createServer(async (req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(await pageHtml())
  } else if (req.url === '/favicon.ico') {
    res.writeHead(204)
    res.end()
  } else if (req.url === '/vue.runtime.min.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' })
    res.end(fs.readFileSync(path.join(root, 'node_modules/vue/dist/vue.runtime.min.js')))
  } else if (req.url === '/fixture.png') {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(png)
  } else if (req.url.startsWith('/download/att-zip')) {
    windowState.downloadCount += 1
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename*=UTF-8''%E8%B5%84%E6%96%99.tar.gz", 'content-length': archiveBytes.length })
    res.end(archiveBytes)
  } else if (req.url === '/state') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ downloadCount: windowState.downloadCount, archiveHash: require('crypto').createHash('sha256').update(archiveBytes).digest('hex') }))
  } else {
    res.writeHead(404)
    res.end('not found')
  }
})
const windowState = { downloadCount: 0 }
server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => {
  const address = server.address()
  console.log(`HARNESS_URL=http://127.0.0.1:${address.port}/`)
  console.log(`ARCHIVE_SHA256=${require('crypto').createHash('sha256').update(archiveBytes).digest('hex')}`)
})
process.on('SIGINT', () => server.close(() => process.exit(0)))
