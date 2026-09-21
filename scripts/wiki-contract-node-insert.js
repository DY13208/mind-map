#!/usr/bin/env node
/**
 * 把一份合同的要素节点插入 Wiki「公司模型」的对应合同分类下。
 *
 * 位置：合同 → 合同分类 → 每一份合同 → 需提取要素 → 要素值
 *
 * 用法：
 *   node scripts/wiki-contract-node-insert.js --elements <要素.json>            # 预演（默认不写）
 *   node scripts/wiki-contract-node-insert.js --elements <要素.json> --apply    # 真正写入
 *
 * 要素.json 格式：
 *   {
 *     "contract": "胡可直播业务合同（still0730）",
 *     "category": "直播推广",
 *     "elements": { "合同双方": ["甲方：…", "乙方：…"], "主要内容": ["…"] }
 *   }
 *
 * 硬校验（不通过就拒绝写入）：
 *   1. category 必须与模型里实时读到的分类名完全一致
 *   2. elements 的键集合必须与该分类模板节点的子节点名完全一致（顺序可不同）
 *   3. 提交前验证「纯新增」：把新子树从新树移除后必须与原 content 逐字节一致
 *
 * 依赖：MCP(mind-map-wiki) 可用；能 docker exec 到 Docmost 库读 pages.content。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
// 端点以 mcp.json 的 mind-map-wiki.url 为准；不要硬编码本机地址
// （2026-09-21 事故：硬编码 127.0.0.1:18792 导致写进了本机另一套 Docmost）
const EP = require('./wiki-endpoint').resolve();
const MCP_URL = EP.url;
const DB_CONTAINER = process.env.DOCMOST_DB_CONTAINER || 'mind-map-docmost-db-1';
const DEFAULT_PAGE_TITLE = '公司模型';
const CONTRACT_ANCHOR = '合同';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const APPLY = args.includes('--apply');
const ELEMENTS_FILE = arg('--elements');
const PAGE_TITLE = arg('--page-title', DEFAULT_PAGE_TITLE);

const log = (...a) => console.log(...a);
const die = (m) => { console.error('✗ ' + m); process.exit(1); };

if (!ELEMENTS_FILE) die('缺少 --elements <要素.json>');
if (!fs.existsSync(ELEMENTS_FILE)) die('要素文件不存在: ' + ELEMENTS_FILE);
const spec = JSON.parse(fs.readFileSync(ELEMENTS_FILE, 'utf8'));
if (!spec.contract) die('要素文件缺少 contract');
if (!spec.category) die('要素文件缺少 category');
if (!spec.elements || typeof spec.elements !== 'object') die('要素文件缺少 elements 对象');

// ---------- MCP 客户端 ----------
function mcpClient() {
  const entry = require('./wiki-endpoint').readEntry();
  if (!entry || !entry.headers || !entry.headers.Authorization) {
    die('mcp.json 里没有 mind-map-wiki 的 Authorization');
  }
  const headers = {
    Authorization: entry.headers.Authorization,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const call = async (p) => {
    const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(p) });
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
    async init() {
      await call({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'insert', version: '1' } } });
      await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    async tool(name, a) {
      const r = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: a } });
      const res = (r && r.result) || {};
      const text = (res.content || [{}])[0].text || '{}';
      if (res.isError) throw new Error(text);
      return JSON.parse(text);
    },
  };
}

// ---------- 库读取（content 必须走库，MCP 的 wiki_read 只给 markdown） ----------
function psql(sql) {
  return execFileSync('docker', ['exec', DB_CONTAINER, 'psql', '-U', 'docmost', '-d', 'docmost', '-t', '-A', '-c', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// ---------- ProseMirror 树工具 ----------
let idSeq = 0;
function nid() {
  // Docmost 的节点 id 形如 12 位小写字母；用确定性前缀避免与既有 id 冲突
  idSeq += 1;
  return ('wb' + idSeq.toString(36) + Math.random().toString(36).slice(2, 10)).slice(0, 12).padEnd(12, 'x');
}
const para = (text) => ({ type: 'paragraph', attrs: { id: nid(), dir: 'auto', indent: 0 }, content: [{ text: String(text), type: 'text' }] });
function item(text, children) {
  const node = { type: 'listItem', attrs: { dir: 'auto' }, content: [para(text)] };
  if (children && children.length) {
    node.content.push({ type: 'bulletList', attrs: { dir: 'auto' }, content: children });
  }
  return node;
}
const label = (n) => (n.type === 'listItem'
  ? textOf((n.content || [{}])[0])
  : textOf(n)).trim();
function textOf(n) {
  if (!n) return '';
  if (n.type === 'text') return n.text || '';
  return (n.content || []).map(textOf).join('');
}
/** listItem 的"子项"在它内部的 bulletList 里，不是直接子节点 */
function childItems(node) {
  const list = (node.content || []).find((c) => c.type === 'bulletList');
  return list ? (list.content || []).filter((c) => c.type === 'listItem') : [];
}
function bulletListOf(node) {
  return (node.content || []).find((c) => c.type === 'bulletList') || null;
}
function findContractContainer(doc) {
  // 「合同」容器：标签精确等于「合同」，且其子项中至少一个自身还有子项（存在模板结构）
  const queue = [doc];
  while (queue.length) {
    const n = queue.shift();
    for (const c of n.content || []) {
      if (c.type === 'listItem' && label(c) === CONTRACT_ANCHOR) {
        if (childItems(c).some((k) => childItems(k).length > 0)) return c;
      }
      queue.push(c);
    }
  }
  return null;
}
function stripIds(n) {
  const o = Object.assign({}, n);
  if (o.attrs && typeof o.attrs === 'object') {
    o.attrs = Object.fromEntries(Object.entries(o.attrs).filter(([k]) => k !== 'id'));
  }
  if (Array.isArray(o.content)) o.content = o.content.map(stripIds);
  return o;
}

// ---------- 主流程 ----------
(async () => {
  const client = mcpClient();
  await client.init();

  // 1) 定位页面（按标题，不写死 pageId）
  const found = await client.tool('wiki_search', { query: PAGE_TITLE, limit: 10 });
  const page = (found.items || []).find((i) => i.title === PAGE_TITLE);
  if (!page) die(`未找到 Wiki 页面「${PAGE_TITLE}」`);
  log('页面：%s (%s)', page.title, page.pageId);

  // 2) 读全文（markdown 用于人读校验；content 用于改写）
  const doc = await client.tool('wiki_read', { pageId: page.pageId });
  if (doc.truncated) log('⚠ 该页 wiki_read 被截断（%d 字符），要素校验以库里的 content 为准', doc.bodyChars);

  // 3) 备份 content
  //    ★ 关键护栏：content 是用「本机 Docker 的 psql」读的，而写入走 MCP_URL。
  //      两者若指向不同的 Docmost，就会「读A写B」——2026-09-21 事故正是如此。
  //      这里强制确认 page.pageId 在本机库里真实存在，否则拒绝继续。
  const backupDir = path.join(ROOT, 'tmp', 'wiki-backup');
  fs.mkdirSync(backupDir, { recursive: true });
  const probe = psql(`select count(*) from pages where id::text='${page.pageId}';`).trim();
  if (probe !== '1') {
    die([
      '页面来源校验失败：MCP 端返回的 pageId 在本机 Docmost 库里不存在。',
      `  MCP 端点        : ${MCP_URL}`,
      `  MCP 返回 pageId : ${page.pageId}`,
      `  本机库命中条数  : ${probe}`,
      '',
      '  说明 MCP 端点与你本机 Docker 里的 Docmost 不是同一套数据。',
      '  脚本用本机 psql 读 content、却会用 MCP 写回，属于「读A写B」，已中止。',
      '  处理：把 mcp.json 的 mind-map-wiki.url 改回本机回环地址，',
      '        或改用能读到目标库的 DOCMOST_DB_CONTAINER。',
    ].join('\n'));
  }
  const raw = psql(`select content from pages where id::text='${page.pageId}';`).trim();
  if (!raw) die('读不到 pages.content');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `${PAGE_TITLE}-${stamp}.json`);
  fs.writeFileSync(backupFile, raw, 'utf8');
  log('已备份原文 → %s', backupFile);

  const tree = JSON.parse(raw);
  const original = JSON.parse(JSON.stringify(tree));

  // 4) 定位 合同容器 → 分类 → 模板
  const container = findContractContainer(tree);
  if (!container) die(`在模型里没找到结构完整的「${CONTRACT_ANCHOR}」节点`);
  const branches = childItems(container);
  const categoryNames = branches.map(label);
  log('模型现有分类：%s', categoryNames.join('、'));

  const branch = branches.find((b) => label(b) === spec.category);
  if (!branch) die(`分类「${spec.category}」不在模型中。现有：${categoryNames.join('、')}（分类名必须与模型一致）`);

  const kids = childItems(branch);
  if (!kids.length) die(`分类「${spec.category}」下没有模板节点`);
  const template = kids[0];
  const templateElements = childItems(template).map(label);
  log('该分类模板：%s，要素：%s', label(template), templateElements.join(' / '));

  // ★ 硬校验：要素名必须与实时读到的完全一致
  const given = Object.keys(spec.elements);
  const missing = templateElements.filter((e) => !given.includes(e));
  const extra = given.filter((e) => !templateElements.includes(e));
  if (missing.length || extra.length) {
    die([
      '要素名与模型不一致，拒绝写入。',
      missing.length ? '  模型有但你没给：' + missing.join('、') : '',
      extra.length ? '  你给了但模型没有：' + extra.join('、') : '',
      '  （要素名必须用实时读到的名字，不要用记忆或旧列表）',
    ].filter(Boolean).join('\n'));
  }

  // 5) 查重
  const existing = kids.slice(1).map(label);
  if (existing.includes(spec.contract)) die(`分类「${spec.category}」下已存在同名合同节点：${spec.contract}`);

  // 6) 构造子树（按模板顺序排列要素）
  const ordered = templateElements.map((name) => {
    const vals = spec.elements[name];
    const list = Array.isArray(vals) ? vals : [vals];
    return item(name, list.filter((v) => v != null && String(v).trim() !== '').map((v) => item(String(v))));
  });
  const newItem = item(spec.contract, ordered);

  // 7) 插入到模板之后
  const listHost = bulletListOf(branch);
  if (!listHost) die('分类节点下没有 bulletList');
  listHost.content.push(newItem);
  log('将新增节点数：%d', 1 + ordered.length + ordered.reduce((s, e) => s + childItems(e).length, 0));

  // 8) ★ 纯新增校验
  const check = JSON.parse(JSON.stringify(tree));
  const c2 = findContractContainer(check);
  const b2 = childItems(c2).find((b) => label(b) === spec.category);
  const l2 = bulletListOf(b2);
  l2.content = l2.content.filter((c) => label(c) !== spec.contract);
  const same = JSON.stringify(stripIds(check)) === JSON.stringify(stripIds(original));
  if (!same) die('纯新增校验失败：移除新子树后与原文不一致，已中止');
  log('纯新增校验通过 ✓');

  if (!APPLY) {
    log('');
    log('预演完成，未写入。加 --apply 执行。');
    return;
  }

  // 9) 写入
  const res = await client.tool('wiki_update', { pageId: page.pageId, format: 'json', operation: 'replace', content: tree });
  log('写入返回 status=%s audit=%s', res.status, JSON.stringify(res.audit || {}));

  // 10) 三点验证
  const row = psql(`select (content::text like '%${spec.contract}%')::text || '|' || (coalesce(text_content,'') like '%${spec.contract}%')::text || '|' || (tsv is not null)::text from pages where id::text='${page.pageId}';`).trim();
  const [c1, c2v, c3] = row.split('|');
  log('验证：content=%s text_content=%s tsv存在=%s', c1, c2v, c3);
  if (c1 !== 'true' || c2v !== 'true') die('写入后校验未通过，请用备份回滚：' + backupFile);

  log('');
  log('✓ 已插入「%s」到 %s / %s', spec.contract, spec.category, PAGE_TITLE);
  log('  回滚：用 %s 覆盖回 pages.content', backupFile);
})().catch((e) => die(e.message));
