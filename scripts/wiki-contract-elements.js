#!/usr/bin/env node
/**
 * 从 Wiki「公司模型」实时读出合同要素清单（不硬编码任何要素名/分类/pageId）。
 *
 * 用法：
 *   node scripts/wiki-contract-elements.js                  # 列出全部合同分类及要素
 *   node scripts/wiki-contract-elements.js 直播推广          # 只看某一分类
 *   node scripts/wiki-contract-elements.js --json           # 机器可读，供上游脚本消费
 *
 * 设计原则：要素定义只存在于 Wiki，本脚本只做「读取 + 按结构解析」，
 * 马堃在模型里加分类/改要素后，无需改任何代码或提示词即自动跟随。
 */
const fs = require('fs');
const path = require('path');

const MCP_CFG = path.join(process.env.USERPROFILE || process.env.HOME || '', '.workbuddy', 'mcp.json');
const { directChildren, findStructural, parseCompanyModel } = require('./wiki-model-schema');
const MODEL_TITLE = '公司模型';
const FEE_ANCHOR = '渠道法务分';          // 评分因子所在分支

function readToken() {
  const cfg = JSON.parse(fs.readFileSync(MCP_CFG, 'utf8'));
  const entry = cfg.mcpServers && cfg.mcpServers['mind-map-wiki'];
  if (!entry || !entry.headers || !entry.headers.Authorization) {
    throw new Error('mcp.json 里没有 mind-map-wiki 的 Authorization');
  }
  return entry.headers.Authorization.replace(/^Bearer\s+/i, '');
}

function makeClient(token) {
  // 端点以 mcp.json 的 mind-map-wiki.url 为准；不要在这里硬编码本机地址
  // （2026-09-21 事故：硬编码 127.0.0.1:18792 导致写进了本机另一套 Docmost）
  const URL = require('./wiki-endpoint').resolve().url;
  const headers = {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const call = async (payload) => {
    const res = await fetch(URL, { method: 'POST', headers, body: JSON.stringify(payload) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) headers['mcp-session-id'] = sid;
    const text = await res.text();
    if (!text) return {};
    if (text.trimStart().startsWith('{')) return JSON.parse(text);
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    return line ? JSON.parse(line.slice(5).trim()) : {};
  };
  return {
    call,
    async initialize() {
      await call({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'schema', version: '1' } } });
      await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    async tool(name, args) {
      const r = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
      const res = (r && r.result) || {};
      const text = (res.content || [{}])[0].text || '{}';
      if (res.isError) throw new Error(text);
      return JSON.parse(text);
    },
  };
}

(async () => {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const want = args.find((a) => !a.startsWith('--')) || null;

  const client = makeClient(readToken());
  await client.initialize();

  const found = await client.tool('wiki_search', { query: MODEL_TITLE, limit: 20 });
  const pages = (found.items || []).filter((i) => i.title === MODEL_TITLE);
  if (!pages.length) throw new Error('未找到 Wiki 页面「' + MODEL_TITLE + '」');

  // 同名页面可能只是目录短页。读到结构完整的「合同」容器，并在多页都能解析时取正文最长的一页。
  let page = null;
  let doc = null;
  let nodes = null;
  let branches = null;
  let bestScore = -1;
  for (const candidate of pages) {
    const read = await client.tool('wiki_read', { pageId: candidate.pageId });
    let parsed;
    try {
      parsed = parseCompanyModel(read.body || '');
    } catch (error) {
      if (error.code === 'MODEL_CONTRACT_MISSING') continue;
      throw error;
    }
    const score = read.bodyChars || (read.body || '').length;
    if (score > bestScore) {
      bestScore = score;
      page = candidate;
      doc = read;
      nodes = parsed.nodes;
      branches = parsed.branches;
    }
  }
  if (!page) throw new Error('在模型里没找到结构完整的「合同」节点');
  if (doc.truncated) {
    console.error('[警告] 页面被截断（bodyChars=%s），要素清单可能不完整——请调高 KNOWLEDGE_WIKI_MAX_BODY 或直连数据库。', doc.bodyChars);
  }

  // 渠道法务评分因子：渠道法务分 → 按渠道类型 → <类型> → 因子 → 因子名
  // 结构校验：必须能找到「按渠道类型」子节点，否则命中的是叶子里的同名子串
  const feeIdx = findStructural(
    nodes,
    (t) => t === FEE_ANCHOR,
    (i) => directChildren(nodes, i).some((c) => c.text.includes('按渠道类型')),
  );
  const feeFactors = [];
  if (feeIdx >= 0) {
    const typeRoot = directChildren(nodes, feeIdx).find((c) => c.text.includes('按渠道类型'));
    for (const type of directChildren(nodes, typeRoot.idx)) {
      const factorNode = directChildren(nodes, type.idx).find((c) => c.text.includes('因子'));
      const host = factorNode || type;
      feeFactors.push({
        类型: type.text,
        评分因子: directChildren(nodes, host.idx).map((c) => c.text),
      });
    }
  }

  const result = {
    模型页面: { title: page.title, pageId: page.pageId, bodyChars: doc.bodyChars, truncated: !!doc.truncated },
    合同要素: branches,
    渠道法务评分因子: feeFactors,
  };

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('模型页面：%s (%s)，%d 字符%s', page.title, page.pageId, doc.bodyChars, doc.truncated ? ' [已截断]' : '');
  console.log('');
  console.log('合同分类 → 要素清单（实时读取，未硬编码）');
  for (const b of branches) {
    if (want && b.分类 !== want) continue;
    console.log('');
    console.log('▌ %s   （模板节点：%s）', b.分类, b.模板节点 || '无');
    for (const e of b.要素) console.log('    · %s', e);
    if (b.已有合同.length) console.log('    已收录合同：%s', b.已有合同.join('、'));
  }
  if (feeFactors.length) {
    console.log('');
    console.log('渠道法务评分因子（风险评估用，与上面的"提取要素"不同）');
    for (const f of feeFactors) console.log('  %s：%s', f.类型, f.评分因子.join(' / '));
  }
})().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
