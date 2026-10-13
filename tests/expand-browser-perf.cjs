const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const repo = path.resolve(__dirname, '..')
const { chromium } = require(path.join(repo, 'simple-mind-map/node_modules/@playwright/test'))
const esbuild = require(path.join(repo, 'web/node_modules/esbuild'))
async function main() {
  const build = await esbuild.build({ stdin: { resolveDir: repo, contents: `
    import MindMap from './simple-mind-map/index.js';
    window.create = async count => {
      const root={data:{uid:'root',text:'Root'},children:[]};
      for(let b=0;b<10;b++) {
        const branch={data:{uid:'b'+b,text:'Branch '+b,expand:false},children:[]};
        for(let i=0;i<count/10;i++)branch.children.push({data:{uid:b+'-'+i,text:'Node '+i},children:[]});
        root.children.push(branch);
      }
      if(window.mm)mm.destroy();
      window.mm=new MindMap({el:document.getElementById('map'),data:root,openPerformance:true,openRealtimeRenderOnNodeTextEdit:false});
      await new Promise(r=>mm.on('node_tree_render_end',r));
    };
    window.measure=async () => {
      const node=mm.renderer.findNodeByUid('b0');
      const phases={};
      for(const name of ['computedBaseValue','computedTopValue','adjustTopValue']){
        const layout=mm.renderer.layout,original=layout[name];
        layout[name]=function(...args){const t=performance.now();const result=original.apply(this,args);if(result?.then)return result.then(value=>{phases[name]=(phases[name]||0)+performance.now()-t;return value});phases[name]=(phases[name]||0)+performance.now()-t;return result};
      }
      let inputTurns=0,lastTurn=performance.now(),maxPauseMs=0;
      const timer=setInterval(()=>{const now=performance.now();maxPauseMs=Math.max(maxPauseMs,now-lastTurn);lastTurn=now;inputTurns++},10);
      const run=expand=>new Promise(resolve=>{
        const started=performance.now();
        const done=()=>{mm.off('node_tree_render_end',done);resolve(performance.now()-started)};
        mm.on('node_tree_render_end',done);mm.execCommand('SET_NODE_EXPAND',node,expand);
      });
      const expandMs=await run(true),collapseMs=await run(false);
      clearInterval(timer);
      return {expandMs,collapseMs,inputTurns,maxPauseMs,phases,collapsed:node.getData('expand')===false,children:node.nodeData.children.length};
    };` }, bundle: true, write: false, format: 'iife', platform: 'browser', loader: { '.svg': 'dataurl', '.png': 'dataurl' } })
  const bundle = build.outputFiles[0].text
  const server = http.createServer((req,res) => {
    if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle)}
    else res.end('<html><body><div id="map" style="width:1200px;height:800px"></div><script src="/bundle.js"></script></body></html>')
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  let browser
  try {
    browser=await chromium.launch({headless:true,channel:'msedge'})
    const page=await browser.newPage({viewport:{width:1280,height:900}})
    const errors=[];page.on('pageerror',e=>errors.push(e.message))
    await page.goto('http://127.0.0.1:'+server.address().port)
    const results=[]
    for(const nodes of [1000,5000]){
      await page.evaluate(n=>window.create(n),nodes)
      const result=await page.evaluate(()=>window.measure())
      assert.equal(result.collapsed,true);assert.equal(result.children,nodes/10)
      assert.ok(result.inputTurns>0,'browser event loop must keep making progress during expansion')
      results.push({nodes,...result})
    }
    assert.deepEqual(errors,[])
    console.log(JSON.stringify(results,null,2))
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve))}
}
main().catch(e=>{console.error(e);process.exitCode=1})
