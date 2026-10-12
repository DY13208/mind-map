const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict')
const repo=path.resolve(__dirname,'..')
const {chromium}=require(path.join(repo,'simple-mind-map/node_modules/@playwright/test'))
const compiler=require(path.join(repo,'web/node_modules/vue-template-compiler'))
async function main(){
  const s=compiler.parseComponent(fs.readFileSync(path.join(repo,'web/src/pages/Edit/components/HyperlinkPreview.vue'),'utf8'))
  assert.deepEqual(compiler.compile(s.template.content).errors,[])
  const css=await require(path.join(repo,'web/node_modules/less')).render(s.styles[0].content)
  const built=await require(path.join(repo,'web/node_modules/esbuild')).build({stdin:{resolveDir:repo,contents:`import Vue from './web/node_modules/vue/dist/vue.esm.js';import ElementUI from './web/node_modules/element-ui';Vue.use(ElementUI);const Preview=${s.script.content.replace('export default','')};Preview.template=${JSON.stringify(s.template.content)};window.app=new Vue({data:{visible:true,url:location.origin+'/target'},render(h){return h(Preview,{props:{visible:this.visible,url:this.url},on:{close:()=>{this.visible=false;this.url=''}}})}}).$mount('#app');`},bundle:true,write:false})
  const server=http.createServer((req,res)=>{
    if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(built.outputFiles[0].text)}
    else if(req.url==='/target')res.end('<html><body><h1>Embedded page</h1></body></html>')
    else if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(fs.readFileSync(path.join(repo,'web/node_modules/element-ui/lib/theme-chalk/index.css'),'utf8')+'\n'+css.css)}
    else res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script src="/bundle.js"></script></body></html>')
  })
  await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser
  try{
    browser=await chromium.launch({headless:true,channel:'msedge'})
    for(const width of [1280,390]){
      const page=await browser.newPage({viewport:{width,height:900}})
      await page.goto('http://127.0.0.1:'+server.address().port)
      await page.frameLocator('iframe').locator('h1').waitFor()
      assert.equal(await page.locator('.previewExternal').getAttribute('target'),'_blank')
      const box=await page.locator('.hyperlinkPreviewDialog').boundingBox()
      assert.ok(box.x>=0&&box.x+box.width<=width+1)
      await page.locator('.el-dialog__headerbtn').click()
      await page.waitForFunction(()=>document.querySelectorAll('iframe').length===0)
      await page.close()
    }
    console.log('PASS desktop/mobile embedded page, external link, close and iframe cleanup')
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r))}
}
main().catch(e=>{console.error(e);process.exitCode=1})
