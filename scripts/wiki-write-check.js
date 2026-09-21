#!/usr/bin/env node
/**
 * wiki-write-check.js —— 验收 knowledge-mcp 端点是否具备「Wiki 全库读写」能力。
 *
 * 背景（2026-09-21）：线上部署跑的是 0.5.0（16 个工具，Wiki 只读），而
 * `wiki_create` / `wiki_update` 只存在于本地未提交的工作区改动里（0.6.0，18 个工具）。
 * 结果就是「本机能写、线上写不了」，且两端 pageId 体系不同，肉眼难以察觉。
 *
 * 用法：
 *   node scripts/wiki-write-check.js                    # 用 mcp.json 里配置的端点
 *   node scripts/wiki-write-check.js <url>              # 指定端点
 *   node scripts/wiki-write-check.js --expect 18        # 期望工具数，不符则退出码 1
 *   node scripts/wiki-write-check.js --json             # 机器可读输出
 *
 * 退出码：0=具备写能力；1=只读或探测失败。
 */
'use strict';
const path = require('path');
const ep = require(path.join(__dirname, 'wiki-endpoint.js'));

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const pos = args.filter((a) => !a.startsWith('--'));
const idx = args.indexOf('--expect');
const expectCount = idx >= 0 ? Number(args[idx + 1]) : null;

const r = ep.resolve({ url: pos[0], allowLocal: args.includes('--allow-local') });

(async () => {
  const c = ep.makeClient(r.url, r.token);
  await c.initialize();

  const tools = await c.listTools();
  const names = tools.map((t) => t.name).sort();
  const wiki = names.filter((n) => n.startsWith('wiki_'));
  const hasCreate = names.includes('wiki_create');
  const hasUpdate = names.includes('wiki_update');
  const canWrite = hasCreate && hasUpdate;

  // 读路径与写路径共用同一个 docmostApi，读通了基本说明 DOCMOST_* 已就绪。
  let readOk = false;
  let readDetail = '';
  try {
    const sp = await c.tool('wiki_spaces', {});
    readOk = true;
    readDetail = sp.count + ' 个空间';
  } catch (e) {
    readDetail = e.message;
  }

  const report = {
    endpoint: r.url,
    endpointSource: r.source,
    tokenSource: r.token ? 'mcp.json (mind-map-wiki.headers.Authorization)' : '(无)',
    toolCount: tools.length,
    wikiTools: wiki,
    hasCreate,
    hasUpdate,
    canWrite,
    readOk,
    readDetail,
    verdict: canWrite
      ? '具备写能力（0.6.0+）'
      : '只读部署（0.5.0），无法写入 Wiki —— 需要升级镜像',
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('端点        :', report.endpoint);
    console.log('端点来源    :', report.endpointSource);
    console.log('令牌来源    :', report.tokenSource);
    console.log('工具总数    :', report.toolCount);
    console.log('wiki_* 工具 :', wiki.join(', ') || '(无)');
    console.log('含 wiki_create:', hasCreate ? '是' : '否');
    console.log('含 wiki_update:', hasUpdate ? '是' : '否');
    console.log('读能力自检  :', readOk ? '正常（' + readDetail + '）' : '失败（' + readDetail + '）');
    console.log('判定        :', report.verdict);
    if (!canWrite) {
      console.log('\n处理：按 integrations/knowledge-mcp/DEPLOY-WRITE.md 升级该部署的 knowledge-mcp 镜像。');
    }
    if (expectCount != null && tools.length !== expectCount) {
      console.log('\n期望工具数 ' + expectCount + '，实际 ' + tools.length + ' —— 不符。');
    }
  }

  const countMismatch = expectCount != null && tools.length !== expectCount;
  process.exit(canWrite && !countMismatch ? 0 : 1);
})().catch((e) => {
  console.error('探测失败:', e.message);
  process.exit(1);
});
