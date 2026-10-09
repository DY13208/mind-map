const { markdown } = require('../knowledge/markdownRenderer')
function parseContractTree(rows) {
  const children = new Map()
  for (const row of [...rows].sort((a,b) => String(a.position).localeCompare(String(b.position)) || a.uid.localeCompare(b.uid))) {
    const list = children.get(row.parent_uid) || []; list.push(row); children.set(row.parent_uid, list)
  }
  const kids = row => children.get(row.uid) || []
  const text = row => markdown((row.data || {}).text).replace(/\n+/g, ' ').trim()
  const anchor = rows.find(row => text(row) === '合同' && kids(row).some(category => kids(category).length && kids(kids(category)[0]).length))
  if (!anchor) return null
  const categories = kids(anchor).map(category => {
    const [template, ...instances] = kids(category)
    const records = instances.map(record => ({ name: text(record), fields: Object.fromEntries(kids(record).map(field => [text(field), kids(field).map(text)])) }))
    return { nodeUid: category.uid, 分类: text(category), 模板节点: template ? text(template) : '', 要素: template ? kids(template).map(text) : [], 已有合同: records.map(x=>x.name), 合同记录: records }
  })
  return { anchorUid: anchor.uid, categories }
}
const MODEL_TITLE = '公司模型'
function coverage(count) { return count >= 5 ? 'high' : count >= 2 ? 'medium' : 'low' }
const path = require('node:path')
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


module.exports = { parseContractTree, mergeContractSpec, renderTopic }
