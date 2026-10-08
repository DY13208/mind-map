#!/usr/bin/env node
/**
 * 按「公司模型」里的文件分类和字段，把已提取合同编译进 Wiki。
 *
 * 已写进模型的合同按模型原文编译。要素 JSON 里分类对不上的文件也写入：
 * 没有这个分类就按文件自己的分类和字段新建主题；字段比模板多的一并补上。
 * 模型里已经有同名合同的，仍以模型为准，不重复写入。
 *
 *   node scripts/wiki-compile-model.js --wiki-dir <wiki目录>
 *   node scripts/wiki-compile-model.js --wiki-dir <wiki目录> --contracts data/contracts --dry-run
 */
const fs = require('fs');
const path = require('path');
const { parseCompanyModel } = require('./wiki-model-schema');

const ROOT = path.resolve(__dirname, '..');
const MODEL_TITLE = '公司模型';
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const DRY = args.includes('--dry-run');
const WIKI_DIR = arg('--wiki-dir', process.env.WIKI_COMPILE_DIR || '');
const CONTRACTS_DIR = path.resolve(ROOT, arg('--contracts', 'data/contracts'));

function die(message) {
  console.error('✗ ' + message);
  process.exit(1);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function coverage(count) {
  if (count >= 5) return 'high';
  if (count >= 2) return 'medium';
  return 'low';
}

function readToken() {
  const cfgPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.workbuddy', 'mcp.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const entry = cfg.mcpServers && cfg.mcpServers['mind-map-wiki'];
  if (!entry || !entry.headers || !entry.headers.Authorization) {
    throw new Error('mcp.json 里没有 mind-map-wiki 的 Authorization');
  }
  return entry.headers.Authorization.replace(/^Bearer\s+/i, '');
}

function makeClient(token) {
  const endpoint = require('./wiki-endpoint').resolve();
  const headers = {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const call = async (payload) => {
    const res = await fetch(endpoint.url, { method: 'POST', headers, body: JSON.stringify(payload) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) headers['mcp-session-id'] = sid;
    const text = await res.text();
    if (!text) return {};
    if (text.trimStart().startsWith('{')) return JSON.parse(text);
    const line = text.split('\n').find((item) => item.startsWith('data:'));
    return line ? JSON.parse(line.slice(5).trim()) : {};
  };
  return {
    async initialize() {
      await call({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'wiki-compile-model', version: '1' } },
      });
      await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    async tool(name, toolArgs) {
      const response = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: toolArgs } });
      const result = (response && response.result) || {};
      const text = (result.content || [{}])[0].text || '{}';
      if (result.isError) throw new Error(text);
      return JSON.parse(text);
    },
  };
}

async function loadModel() {
  const client = makeClient(readToken());
  await client.initialize();
  const found = await client.tool('wiki_search', { query: MODEL_TITLE, limit: 20 });
  const pages = (found.items || []).filter((item) => item.title === MODEL_TITLE);
  if (!pages.length) throw new Error('未找到 Wiki 页面「' + MODEL_TITLE + '」');

  let best = null;
  for (const page of pages) {
    const doc = await client.tool('wiki_read', { pageId: page.pageId });
    try {
      const parsed = parseCompanyModel(doc.body || '');
      const score = doc.bodyChars || (doc.body || '').length;
      if (!best || score > best.score) best = { page, doc, parsed, score };
    } catch (error) {
      if (error.code !== 'MODEL_CONTRACT_MISSING') throw error;
    }
  }
  if (!best) throw new Error('在模型里没找到结构完整的「合同」节点');
  return best;
}

function fieldValues(value) {
  if (Array.isArray(value)) return value.map(String);
  if (value == null || value === '') return [];
  return [String(value)];
}

function mergeContractSpec(categories, spec, file) {
  const byName = new Map(categories.map((item) => [item.分类, item]));
  const added = [];
  const skipped = [];
  const created = [];
  const name = String(spec.category || '').trim() || path.basename(file, '.json');
  let category = byName.get(name);
  if (!category) {
    category = {
      分类: name,
      模板节点: '文件自带字段',
      要素: [],
      已有合同: [],
      合同记录: [],
    };
    categories.push(category);
    created.push(name);
  }
  const elements = spec.elements || {};
  for (const key of Object.keys(elements)) {
    if (!category.要素.includes(key)) category.要素.push(key);
  }
  const contractName = spec.contract || path.basename(file, '.json');
  if (category.已有合同.includes(contractName)) {
    skipped.push(file + '：模型里已有「' + contractName + '」，以模型为准');
    return { added, skipped, created };
  }
  const fields = {};
  for (const fieldName of category.要素) fields[fieldName] = fieldValues(elements[fieldName]);
  category.合同记录.push({
    name: contractName,
    fields,
    sourceFile: spec.source_file || file,
  });
  category.已有合同.push(contractName);
  added.push(contractName);
  return { added, skipped, created };
}

function loadContractJson(categories) {
  if (!fs.existsSync(CONTRACTS_DIR)) return { added: [], skipped: [], created: [] };
  const added = [];
  const skipped = [];
  const created = [];
  for (const file of fs.readdirSync(CONTRACTS_DIR).filter((name) => name.endsWith('.json'))) {
    const spec = JSON.parse(fs.readFileSync(path.join(CONTRACTS_DIR, file), 'utf8'));
    const result = mergeContractSpec(categories, spec, file);
    added.push(...result.added);
    skipped.push(...result.skipped);
    created.push(...result.created);
  }
  return { added, skipped, created };
}

function sourceLinks(records) {
  const links = ['公司模型 / ' + MODEL_TITLE];
  for (const record of records) {
    if (record.sourceFile) links.push(record.sourceFile);
  }
  return links;
}

function renderTopic(category, date) {
  const records = category.合同记录;
  const lines = [
    '---',
    'topic: ' + category.分类,
    'last_compiled: ' + date,
    'source_count: ' + records.length,
    'status: active',
    '---',
    '',
    '# ' + category.分类,
    '',
    '字段来自公司模型「' + category.分类 + ' / ' + (category.模板节点 || '模板') + '」。',
    '',
  ];
  for (const field of category.要素) {
    const filled = records.filter((record) => (record.fields[field] || []).length > 0);
    lines.push('## ' + field + ' [coverage: ' + coverage(filled.length) + ' -- ' + filled.length + ' sources]');
    lines.push('');
    if (!filled.length) {
      lines.push('尚无已提取合同。');
      lines.push('');
      continue;
    }
    for (const record of filled) {
      lines.push('### ' + record.name);
      lines.push('');
      for (const value of record.fields[field]) lines.push('- ' + value);
      lines.push('');
    }
  }
  lines.push('## Sources');
  lines.push('');
  for (const link of sourceLinks(records)) lines.push('- ' + link);
  lines.push('');
  return lines.join('\n');
}

function renderIndex(categories, date, page) {
  const sourceCount = categories.reduce((sum, item) => sum + item.合同记录.length, 0);
  const lines = [
    '# 公司模型wiki',
    '',
    'Last compiled: ' + date,
    'Total topics: ' + categories.length + ' | Total concepts: 0 | Total sources: ' + sourceCount,
    '',
    '## Topics',
    '',
    '| Topic | Also Known As | Sources | Last Updated | Status |',
    '|-------|--------------|---------|-------------|--------|',
  ];
  for (const category of categories) {
    const alias = category.要素.slice(0, 3).join(', ') || category.模板节点 || '';
    lines.push(
      '| [[topics/' + category.分类 + ']] | ' + alias + ' | ' +
      category.合同记录.length + ' | ' + date + ' | active |',
    );
  }
  lines.push('');
  lines.push('## Recent Changes');
  lines.push('');
  lines.push('- ' + date + ': 按公司模型「' + page.title + '」（' + page.pageId + '）的合同分类与模板字段编译。');
  lines.push('');
  return lines.join('\n');
}

function renderSchema(categories, date) {
  const lines = [
    '# Wiki Schema',
    '',
    '> 主题和字段来自公司模型，不在编译器里另写一套栏目。',
    '',
    '## Topics',
    '',
    '| Slug | 类型 | 描述 |',
    '|------|------|------|',
  ];
  for (const category of categories) {
    lines.push('| ' + category.分类 + ' | topic | 模板字段：' + category.要素.join('、') + ' |');
  }
  lines.push('');
  lines.push('## Evolution Log');
  lines.push('');
  lines.push('- ' + date + ': 改为按公司模型合同分类编译');
  lines.push('');
  return lines.join('\n');
}

function writeFile(filePath, content) {
  if (DRY) {
    console.log('[dry-run] ' + filePath + ' (' + content.length + ' chars)');
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

async function main() {
  if (!WIKI_DIR) die('缺少 --wiki-dir，或设置 WIKI_COMPILE_DIR。不要把输出目录写死在代码里。');
  const wikiDir = path.resolve(WIKI_DIR);
  const loaded = await loadModel();
  const categories = loaded.parsed.branches;
  const extra = loadContractJson(categories);
  const date = today();

  console.log('模型页面：%s (%s)', loaded.page.title, loaded.page.pageId);
  console.log('分类：%s', categories.map((item) => item.分类).join('、'));
  if (extra.created.length) console.log('分类不在模型中，已按文件写入：%s', extra.created.join('、'));
  if (extra.added.length) console.log('从 JSON 补入：%s', extra.added.join('、'));
  for (const note of extra.skipped) console.log('跳过：' + note);

  for (const category of categories) {
    const filePath = path.join(wikiDir, 'topics', category.分类 + '.md');
    writeFile(filePath, renderTopic(category, date));
    console.log('%s → %s（%d 份合同，字段：%s）', category.分类, path.basename(filePath), category.合同记录.length, category.要素.join('、'));
  }
  writeFile(path.join(wikiDir, 'INDEX.md'), renderIndex(categories, date, loaded.page));
  writeFile(path.join(wikiDir, 'schema.md'), renderSchema(categories, date));
  writeFile(path.join(wikiDir, '.compile-state.json'), JSON.stringify({
    last_compiled: date,
    topics: categories.map((item) => item.分类),
    concepts: [],
    source: { title: loaded.page.title, pageId: loaded.page.pageId },
    contracts_dir: CONTRACTS_DIR,
    added_from_json: extra.added,
    total_sources_scanned: categories.reduce((sum, item) => sum + item.合同记录.length, 0),
  }, null, 2) + '\n');
  console.log(DRY ? '预演结束，未写文件。' : '已写入 ' + wikiDir);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('失败：', error.message);
    process.exit(1);
  });
}

module.exports = { mergeContractSpec };
