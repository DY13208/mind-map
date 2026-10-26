"use strict";
// Same native isolated PG/MCP/HTTP/Socket fixture as the text regression.
const fs = require("node:fs"),
  path = require("node:path"),
  Module = require("node:module");
const fixture = path.join(__dirname, "mcp-guards-browser.cjs");
let source = fs.readFileSync(fixture, "utf8");
source = source.replace("'mcp-guards-seed.cjs'", "'paste-connector-seed.cjs'");
source = source.replace(
  "for (const actor of ['owner', 'editor-a', 'editor-b'])",
  "for (const actor of ['owner', 'editor-a'])"
);
const start = source.indexOf("  const converge = async revision => {"),
  end = source.indexOf("\nmain().catch(error =>");
const focused = async function() {
  const { page } = clients[0];
  report.scope =
    "Real compiled App + native collaboration + MCP on ephemeral isolated PostgreSQL; in-app clipboard, no OS clipboard claim";
  const flags = [
    "scopedRemoteLineRender",
    "canvasTextMeasure",
    "scopedRemoteGeometry",
    "deferDraftCopy",
    "analyticEdgeBounds",
    "lazyOffscreenPaint"
  ];
  const bind = (target = page) =>
    target.waitForFunction(
      `(() => {const mm=(${mapInBrowser.toString()})();if(mm)window.__guardMM=mm;return mm&&mm.renderer.root&&!mm.renderer.isRendering&&mm.cooperate.collabV2Adapter.getStatus().phase==='LIVE'})()`
    );
  for (const enabled of [false, true]) {
    await page.goto(
      origin +
        "/?room=" +
        roomKey +
        "&perfFlags=" +
        (enabled ? flags.join(",") : "none")
    );
    await bind();
    await page.waitForTimeout(600);
    const peer = clients[1].page;
    await peer.goto(origin + '/?room=' + roomKey + '&perfFlags=' + (enabled ? flags.join(',') : 'none'));
    await bind(peer);
    await peer.evaluate(() => __guardMM.renderer.setNodeExpand(__guardMM.renderer.findNodeByUid('b0'), false));
    await peer.waitForFunction(() => !__guardMM.renderer.isRendering && __guardMM.renderer.findNodeByUid('b0').getData('expand') === false);
    await peer.evaluate(() => new Promise(resolve => __guardMM.execCommand('GO_TARGET_NODE', 'b0', resolve)));
    await page.evaluate(async () => {
      const mm = __guardMM;
      mm.opt.disabledClipboard = true;
      // Populate connector slots as a previously visited branch would, then let
      // normal viewport filtering detach offscreen SVG without deleting slots.
      await new Promise(resolve => {
        mm.renderer._syncPaintOnce = true;
        mm.render(resolve);
      });
      mm.renderer.clearActiveNodeList();
      for (const uid of ["b1", "b2", "b3"])
        mm.renderer.addNodeToActiveList(mm.renderer.findNodeByUid(uid));
      await mm.renderer.copy();
      mm.renderer.clearActiveNodeList();
      mm.renderer.addNodeToActiveList(mm.renderer.findNodeByUid("b0"));
      window.__pasteGeometry = [];
      window.__pasteTrace = [];
      const submit = mm.cooperate.submitV2.bind(mm.cooperate);
      mm.cooperate.submitV2 = async (type, payload) => {
        __pasteTrace.push({ phase: "submit", type, payload });
        try {
          const result = await submit(type, payload);
          __pasteTrace.push({ phase: "ack", type, result });
          return result;
        } catch (error) {
          __pasteTrace.push({
            phase: "error",
            type,
            code: error.code,
            message: error.message
          });
          throw error;
        }
      };
      const capture = () => {
        const rows = [];
        for (const n of Object.values(mm.renderer.nodeCache))
          for (const l of n._lines || [])
            if (l.node.isConnected)
              rows.push({ uid: n.getData("uid"), d: l.node.getAttribute("d") });
        __pasteGeometry.push(rows);
      };
      const renderLine = mm.renderer.layout.renderLine.bind(mm.renderer.layout);
      // Read the same real layout output through detached SVG paths as oracle.
      window.__inspectPaste = () => {
        const stale = [];
        for (const n of Object.values(mm.renderer.nodeCache)) {
          if (!n._lines?.some(l => l.node.isConnected)) continue;
          const actual = n._lines
            .filter(l => l.node.isConnected)
            .map(l => l.node.getAttribute("d"));
          const draw = mm.lineDraw,
            original = draw.path.bind(draw),
            previous = n._lines;
          const stubs = n.children.map(() => original().remove());
          n._lines = stubs.slice();
          draw.path = () => {
            const p = original().remove();
            stubs.push(p);
            return p;
          };
          try {
            renderLine(n, stubs, () => {}, n.style.getStyle("lineStyle", true));
          } finally {
            draw.path = original;
            n._lines = previous;
          }
          const expected = new Set(stubs.map(l => l.node.getAttribute("d")));
          for (const d of actual)
            if (!expected.has(d)) stale.push({ uid: n.getData("uid"), d });
        }
        return stale;
      };
      mm.on("node_tree_render_end", capture);
      await mm.renderer.paste();
    });
    await page.waitForFunction(
      () => {
        const mm = __guardMM,
          c = mm.cooperate,
          s = c.collabV2Adapter.getStatus();
        return (
          !mm.renderer.isRendering &&
          !mm.renderer.renderTimer &&
          !c.httpInsertPromise &&
          s.pendingCount === 0
        );
      },
      null,
      { timeout: 60000 }
    );
    await page.waitForTimeout(800);
    const result = await page.evaluate(() => ({
      stale: __inspectPaste(),
      trace: __pasteTrace,
      status: __guardMM.cooperate.collabV2Adapter.getStatus(),
      children: __guardMM.renderer.findNodeByUid("b0").nodeData.children.length
    }));
    assert.equal(
      result.stale.length,
      0,
      "batch paste leaves no stale connectors before scrolling"
    );
    assert.ok(result.children >= 7, "three branches were pasted");
    assert.equal(result.status.saveState, 'saved', 'paste must not leave a precondition failure');
    assert.equal(result.trace.filter(t => t.phase === 'error').length, 0);
    assert.equal(result.trace.filter(t => t.phase === 'submit' && t.type === 'node.batch').length, 1,
      'canonical ordering must not produce a second style update batch');
    const total = (await pool.query(`with recursive descendants as (
      select uid from room_nodes where room_key=$1 and parent_uid='b0' and deleted_at is null
      union all select n.uid from room_nodes n join descendants d on n.parent_uid=d.uid
      where n.room_key=$1 and n.deleted_at is null
    ) select count(*)::int as total from descendants`, [roomKey])).rows[0].total;
    await peer.waitForFunction(total => {
      const n=__guardMM.renderer.findNodeByUid('b0');
      return n && n.getData('expand') === false && n.getExpandBtnCount() === total;
    }, total, {timeout:20000}).catch(async error => {
      report.countDiagnostic = await peer.evaluate(() => {const c=__guardMM.cooperate,n=__guardMM.renderer.findNodeByUid('b0');return {data:n.getData(),badge:n.getExpandBtnCount(),done:c._badgeCountRefreshDone?.revision,pending:c._badgeCountRefreshPending?.revision,revision:c.lastAppliedVersion,status:c.collabV2Adapter.getStatus()}});
      report.countExpected=total;
      throw error;
    });
    await peer.evaluate(() => new Promise(resolve => __guardMM.execCommand('GO_TARGET_NODE', 'b0', resolve)));
    await peer.waitForFunction(() => !!__guardMM.renderer.findNodeByUid('b0')?._expandBtn?.node?.isConnected);
    const peerCount = await peer.evaluate(() => {const n=__guardMM.renderer.findNodeByUid('b0');return {
      badge:n.getExpandBtnCount(), svg:n._expandBtn.node.textContent, collapsed:n.getData('expand')===false,
      status:__guardMM.cooperate.collabV2Adapter.getStatus()
    }});
    assert.ok(peerCount.svg.includes(String(total)), 'the actual collapsed SVG badge must update');
    await peer.screenshot({path:path.join(OUT,(enabled?'all-on':'all-off')+'-peer-count.png')});
    const server = await query("b0");
    assert.equal(server.toolError, false);
    await page.waitForTimeout(300);
    await page.screenshot({
      path: path.join(
        OUT,
        (enabled ? "all-on" : "all-off") + "-after-paste.png"
      )
    });
    await page.mouse.wheel(0, 500);
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(400);
    const afterPan = await page.evaluate(() => __inspectPaste());
    assert.equal(afterPan.length, 0);
    await page.reload();
    await bind();
    await page.waitForTimeout(400);
    const refreshed = await page.evaluate(() => ({
      children: __guardMM.renderer.findNodeByUid("b0").nodeData.children.length,
      status: __guardMM.cooperate.collabV2Adapter.getStatus()
    }));
    assert.equal(
      refreshed.children,
      result.children,
      "pasted nodes survive F5"
    );
    await peer.reload();await bind(peer);
    await peer.waitForFunction(total => __guardMM.renderer.findNodeByUid('b0')?.getExpandBtnCount() === total, total);
    report.checks.push({ enabled, result, afterPan, refreshed, server, total, peerCount });
    console.log(
      JSON.stringify({
        enabled,
        stale: result.stale.length,
        children: refreshed.children,
        save: refreshed.status.saveState
      })
    );
  }
  report.renderingPassed = true;
  report.persistencePassed = true;
  report.scopeLimitations = report.checks.some(c =>
    (c.result.status.outboxInspect || []).some(op => op.quarantined)
  )
    ? [
        "Paste rendering/persistence checks passed, but a separate post-paste update was quarantined; this is not a clean collaboration acceptance."
      ]
    : [];
  report.collaborationClean = report.scopeLimitations.length === 0;
  report.passed = report.collaborationClean;
  if (!report.collaborationClean) process.exitCode = 1;
};
source =
  source.slice(0, start) +
  "\n await (" +
  focused.toString() +
  ")()\n}\n" +
  source.slice(end);
const runtime = new Module(fixture, module);
runtime.filename = fixture;
runtime.paths = module.paths;
runtime._compile(source, fixture);
