"use strict";
// Two-client remote paste badge regression on the isolated PG/MCP fixture (temp DB/room).
const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const fixture = path.join(__dirname, "mcp-guards-browser.cjs");
let source = fs.readFileSync(fixture, "utf8");
source = source.replace("'mcp-guards-seed.cjs'", "'paste-connector-seed.cjs'");
source = source.replace("for (const actor of ['owner', 'editor-a', 'editor-b'])", "for (const actor of ['owner', 'editor-a'])");
const start = source.indexOf("  const converge = async revision => {"), end = source.indexOf("\nmain().catch(error =>");
const focused = async function() {
  const { page } = clients[0], peer = clients[1].page;
  report.scope = "Compiled App + native collab on ephemeral PG; A pastes a 3-level branch 3x, B (open before) keeps copies collapsed with refresh-equal badges";
  const bind = target => target.waitForFunction(`(() => {const mm=(${mapInBrowser.toString()})();if(mm)window.__guardMM=mm;return mm&&mm.renderer.root&&!mm.renderer.isRendering&&mm.cooperate.collabV2Adapter.getStatus().phase==='LIVE'})()`);
  const inbox = target => target.evaluate(() => {const st=[document.querySelector('#app').__vue__];while(st.length){const vm=st.pop();if(vm.$options.name==='ConflictDraftInbox'){window.__inbox=vm;break}st.push(...vm.$children)}});
  const idle = target => target.waitForFunction(() => {const mm=__guardMM,c=mm.cooperate,s=c.collabV2Adapter.getStatus();return !mm.renderer.isRendering&&!mm.renderer.renderTimer&&!c.httpInsertPromise&&s.pendingCount===0}, null, {timeout:60000});
  await page.goto(origin + "/?room=" + roomKey); await bind(page);
  await peer.goto(origin + "/?room=" + roomKey); await bind(peer); await inbox(peer);
  // B: personal collapse of an existing expanded branch; snapshot lazily collapsed nodes
  await peer.evaluate(() => __guardMM.renderer.setNodeExpand(__guardMM.renderer.findNodeByUid('b5'), false));
  await idle(peer); await peer.waitForTimeout(500);
  const snap = () => peer.evaluate(() => {const out={};const w=n=>{out[n.data.uid]={expand:n.data.expand,children:(n.children||[]).length};(n.children||[]).forEach(w)};w(__guardMM.renderer.renderTree);return out});
  const before = await snap();
  const draftsBefore = await peer.evaluate(() => (window.__inbox?.actionableDrafts||[]).length);
  const b2Before = await peer.evaluate(() => {const n=__guardMM.renderer.findNodeByUid('b2');return {left:n.left,top:n.top}});
  await page.evaluate(async () => {const mm=__guardMM;mm.opt.disabledClipboard=true;mm.renderer.clearActiveNodeList();mm.renderer.addNodeToActiveList(mm.renderer.findNodeByUid('b1'));await mm.renderer.copy()});
  for (let i = 0; i < 3; i++) {
    await page.evaluate(async () => {const mm=__guardMM;mm.renderer.clearActiveNodeList();mm.renderer.addNodeToActiveList(mm.renderer.findNodeByUid('b2'));await mm.renderer.paste()});
    await idle(page); await page.waitForTimeout(500);
  }
  const aSide = await page.evaluate(() => {const b2=__guardMM.renderer.findNodeByUid('b2').nodeData;const cnt=n=>(n.children||[]).reduce((s,c)=>s+1+cnt(c),0);const uids=n=>[n.data.uid,...(n.children||[]).flatMap(uids)];return b2.children.slice(4).map(r=>({uid:r.data.uid,descendants:cnt(r),uids:uids(r).sort()}))});
  assert.equal(aSide.length, 3, "A pasted three copies");
  aSide.forEach(r => assert.equal(r.descendants, 16, "A copy keeps all 3 levels"));
  const dbCounts = {};
  for (const r of aSide) dbCounts[r.uid] = (await pool.query(`with recursive d as (select uid from room_nodes where room_key=$1 and parent_uid=$2 and deleted_at is null union all select n.uid from room_nodes n join d on n.parent_uid=d.uid where n.room_key=$1 and n.deleted_at is null) select count(*)::int t from d`, [roomKey, r.uid])).rows[0].t;
  const readB = () => peer.evaluate(uids => uids.map(uid => {const n=__guardMM.renderer.findNodeByUid(uid);return n?{uid,expand:n.getData('expand'),badge:n.getExpandBtnCount(),mounted:(n.children||[]).length,svg:n._expandBtn?.node?.textContent||'',btnConnected:!!n._expandBtn?.node?.isConnected,lastType:n._lastExpandBtnType,childCount:n.getData('childCount'),descendantCount:n.getData('descendantCount'),hasMore:!!n.getData('hasMore'),sameRaw:true}:{uid,missing:true}}), aSide.map(r=>r.uid));
  await idle(peer); await peer.waitForTimeout(2500);
  const live = await readB();
  report.aSide = aSide.map(r=>({uid:r.uid,descendants:r.descendants})); report.dbCounts = dbCounts; report.bLive = live;
  const after = await snap();
  const draftsAfter = await peer.evaluate(() => (window.__inbox?.actionableDrafts||[]).length);
  const b2After = await peer.evaluate(() => {const n=__guardMM.renderer.findNodeByUid('b2');return {left:n.left,top:n.top}});
  report.drafts = {draftsBefore, draftsAfter}; report.b2Pos = {b2Before, b2After};
  await peer.screenshot({path: path.join(OUT, "peer-live.png")});
  // A deletes one child branch (1+3 nodes) of copy #1, then undoes; B badge must follow 12 -> 16
  const delUid = await page.evaluate(async uid => {const mm=__guardMM;const r=mm.renderer.findNodeByUid(uid);const c=r.children[0];const id=c.getData('uid');mm.renderer.clearActiveNodeList();mm.renderer.addNodeToActiveList(c);mm.execCommand('REMOVE_NODE');return id}, aSide[0].uid);
  await idle(page); const waitBadge = async (want, label) => { try { await peer.waitForFunction(([u,w]) => {const n=__guardMM.renderer.findNodeByUid(u);return n&&n.getExpandBtnCount()===w&&(n._expandBtn?.node?.textContent||'')===String(w)}, [aSide[0].uid, want], {timeout:20000}); return true } catch (e) { report[label] = (await readB())[0]; return false } };
  const afterDelete = await waitBadge(12, 'afterDeleteDiag');
  await page.evaluate(() => __guardMM.execCommand('BACK')); await idle(page);
  const afterUndo = await waitBadge(16, 'afterUndoDiag');
  report.deleteUndo = {delUid, afterDelete, afterUndo};
  await peer.reload(); await bind(peer); await idle(peer); await peer.waitForTimeout(2500); await peer.evaluate(()=>__guardMM.execCommand('SET_NODE_EXPAND', __guardMM.renderer.findNodeByUid('b2'), true)); await peer.waitForFunction(u=>u.every(x=>__guardMM.renderer.findNodeByUid(x)), aSide.map(r=>r.uid), {timeout:20000}).catch(()=>{}); await idle(peer); await peer.waitForTimeout(1500); report.bRefreshTree = await peer.evaluate(()=>{const n=__guardMM.renderer.findNodeByUid('b2');return n?{expand:n.getData('expand'),raw:(n.nodeData.children||[]).map(c=>c.data.uid),mounted:(n.children||[]).length,data:{childCount:n.getData('childCount'),hasMore:n.getData('hasMore')}}:null});
  await peer.evaluate(()=>{const mm=__guardMM;const n=mm.renderer.findNodeByUid('b2');if(n&&n.getData('expand')===false)mm.execCommand('SET_NODE_EXPAND',n,true)}); await peer.waitForFunction(uids=>uids.every(u=>__guardMM.renderer.findNodeByUid(u)),aSide.map(r=>r.uid),{timeout:20000}).catch(()=>{}); await idle(peer); await peer.waitForTimeout(1500);
const refreshed = await readB(); report.bRefreshed = refreshed;
  // expand one copy after refresh: full subtree uids must match A
  const expanded = await peer.evaluate(async uid => {const mm=__guardMM;const n=mm.renderer.findNodeByUid(uid);if(!n)return -1;mm.execCommand('SET_NODE_EXPAND', n, true);await new Promise(r=>setTimeout(r,2500));const raw=mm.renderer.findNodeByUid(uid).nodeData;const all=x=>[x.data.uid,...(x.children||[]).flatMap(all)];const hidden=(raw.children||[]).reduce((s,c)=>{const v=mm.renderer.findNodeByUid(c.data.uid);return s+(c.data.expand===false&&v?v.getExpandBtnCount():0)},0);return all(raw).length+hidden}, aSide[0].uid);
  report.bExpandedCount = expanded;
  const errors = [];
  live.forEach((b, i) => {
    if (b.missing) return errors.push(b.uid + " missing on B");
    if (b.expand !== false) errors.push(b.uid + " auto-expanded on B");
    if (b.mounted) errors.push(b.uid + " mounted children on B (layout expansion)");
    if (b.badge !== dbCounts[b.uid]) errors.push(`${b.uid} live badge ${b.badge} != db ${dbCounts[b.uid]}`);
    if (b.badge !== refreshed[i].badge) errors.push(`${b.uid} live badge ${b.badge} != refreshed ${refreshed[i].badge}`);
    if (!refreshed[i].missing && !refreshed[i].svg.includes(String(dbCounts[b.uid]))) errors.push(b.uid + ' refreshed svg empty');
    if (!b.svg.includes(String(dbCounts[b.uid]))) errors.push(`${b.uid} svg '${b.svg}'`);
  });
  for (const uid of Object.keys(before)) if (before[uid].expand !== after[uid]?.expand) errors.push(uid + " expand state changed on B");
  if (!afterDelete) errors.push('B badge did not drop to 12 after remote delete');
  if (!afterUndo) errors.push('B badge did not return to 16 after undo');
  if (draftsAfter !== draftsBefore) errors.push("new conflict drafts on B");
  if (b2After.left !== b2Before.left) errors.push("b2 moved horizontally on B");
  if (expanded !== 17) errors.push("expanded copy on B has " + expanded + " nodes, expected 17 (loaded + collapsed badges)");
  report.errors = errors;
  console.log(JSON.stringify({live: live.map(b=>b.badge), db: Object.values(dbCounts), refreshed: refreshed.map(b=>b.badge), drafts: report.drafts, expanded, errors}));
  report.passed = errors.length === 0;
  assert.deepEqual(errors, []);
};
source = source.slice(0, start) + "\n await (" + focused.toString() + ")()\n}\n" + source.slice(end);
const runtime = new Module(fixture, module);
runtime.filename = fixture; runtime.paths = module.paths; runtime._compile(source, fixture);




