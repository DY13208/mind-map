const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHarness, repo } = require("./engine-harness.cjs");
const out = path.join(
  repo,
  "output/paste-connector-cleanup",
  new Date().toISOString().replace(/[:.]/g, "-")
);
fs.mkdirSync(out, { recursive: true });
const entry = `
import MindMap from './simple-mind-map/index.js'
import geometry from './simple-mind-map/src/utils/edgeGeometry.js'
const flags = Object.fromEntries(['scopedRemoteLineRender','canvasTextMeasure','scopedRemoteGeometry','deferDraftCopy','analyticEdgeBounds','lazyOffscreenPaint'].map(k=>[k,true]))
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const waitRender=(mm,action)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('render timeout')),5000);const done=()=>{clearTimeout(timer);mm.off('render_complete',done);resolve()};mm.on('render_complete',done);action()})
const tree=()=>({data:{uid:'root',text:'复制粘贴残线隔离测试',expand:true},children:Array.from({length:16},(_,i)=>({data:{uid:'b'+i,text:'分支 '+i,expand:true},children:Array.from({length:4},(_,j)=>({data:{uid:'b'+i+'l'+j,text:'节点 '+i+'/'+j,expand:true},children:Array.from({length:3},(_,k)=>({data:{uid:'b'+i+'l'+j+'s'+k,text:'末级 '+k},children:[]}))}))}))})
let mm
function inspect(){
 const stale=[], owned=new Set()
 for(const n of Object.values(mm.renderer.nodeCache)){
  const expected=new Set(geometry.captureNodeConnectors(n).map(s=>s.d))
  for(const line of n._lines||[]){const el=line.node;owned.add(el);if(el.isConnected && !expected.has(el.getAttribute('d')))stale.push({uid:n.getData('uid'),d:el.getAttribute('d'),expected:[...expected]})}
 }
 const orphan=[...mm.lineDraw.node.querySelectorAll('path')].filter(el=>!owned.has(el)).map(el=>el.getAttribute('d'))
 return {b8:mm.renderer.findNodeByUid('b8')?.top,count:Object.keys(mm.renderer.nodeCache).length,flags:mm.opt.performanceFlags,stale,orphan,paths:mm.lineDraw.node.querySelectorAll('path').length}
}
window.fixture={
 async create(perf,enabled){if(mm)mm.destroy();document.querySelector('#map').innerHTML=''; mm=new MindMap({el:document.querySelector('#map'),data:tree(),layout:'logicalStructure',fit:false,openPerformance:perf,performanceConfig:{padding:0},performanceFlags:enabled?flags:{},createNewNodeBehavior:'NOT_ACTIVE',addHistoryTime:0});window.mm=mm;await waitRender(mm,()=>mm.render());mm.renderer._syncPaintOnce=true;await waitRender(mm,()=>mm.render());await sleep(50);return inspect()},
 async paste(){window.commandTrace=[];mm.on('beforeExecCommand',(name,...args)=>commandTrace.push({name,args:args.map(a=>Array.isArray(a)?a.length:typeof a)}));const target=mm.renderer.findNodeByUid('b0');const clean=n=>({data:JSON.parse(JSON.stringify(n.data)),children:(n.children||[]).map(clean)});const copies=[1,2,3].map(i=>clean(mm.renderer.findNodeByUid('b'+i).nodeData));await waitRender(mm,()=>mm.execCommand('PASTE_NODE',copies,[target]));await sleep(50);return inspect()},
 async pan(){mm.view.translateXY(0,-800);await sleep(300);mm.view.translateXY(0,800);await sleep(300);return inspect()},inspect
}
`;
(async () => {
  const h = await createHarness({ contents: entry });
  const report = {
    scope: "Source-bundled real engine, no collaboration or persistence claim",
    cases: []
  };
  try {
    for (const perf of [false, true])
      for (const enabled of [false, true]) {
        const initial = await h.page.evaluate(
          ({ perf, enabled }) => fixture.create(perf, enabled),
          { perf, enabled }
        );
        const pasted = await h.page.evaluate(() => fixture.paste());
        await h.page.screenshot({
          path: path.join(out, `${perf}-${enabled}-pasted.png`)
        });
        const panned = await h.page.evaluate(() => fixture.pan());
        report.cases.push({ perf, enabled, initial, pasted, panned });
        console.log(
          JSON.stringify({
            perf,
            enabled,
            b8: [initial.b8, pasted.b8],
            count: [initial.count, pasted.count],
            initial: initial.stale.length,
            pasted: pasted.stale.length,
            orphan: pasted.orphan.length,
            panned: panned.stale.length
          })
        );
      }
    report.errors = h.errors;
    fs.writeFileSync(
      path.join(out, "summary.json"),
      JSON.stringify(report, null, 2)
    );
    if (!process.argv.includes("--repro"))
      for (const c of report.cases) {
        assert.equal(
          c.pasted.stale.length,
          0,
          "paste must not leave old connectors"
        );
        assert.equal(
          c.pasted.orphan.length,
          0,
          "paste must not leave orphan paths"
        );
        assert.equal(
          c.panned.stale.length,
          0,
          "panning must not bring stale geometry back"
        );
        assert.equal(
          c.pasted.count - c.initial.count,
          51,
          "all three 17-node subtrees are pasted"
        );
      }
  } catch (error) {
    console.log(
      "DIAGNOSTIC",
      h.errors,
      await h.page.evaluate(() => ({
        rendering: window.mm?.renderer.isRendering,
        waiting: window.mm?.renderer.hasWaitRendering,
        root: !!window.mm?.renderer.root,
        count: Object.keys(window.mm?.renderer.nodeCache || {}).length,
        trace: JSON.stringify(window.commandTrace),
        readonly: window.mm?.opt.readonly,
        commands: Object.keys(window.mm?.command.commands || {}).filter(
          x => x.includes("MULTI") || x.includes("PASTE")
        ),
        kids: window.mm?.renderer.findNodeByUid("b0")?.nodeData.children.length
      }))
    );
    throw error;
  } finally {
    await h.close();
    console.log(out);
  }
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
