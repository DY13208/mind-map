/**
 * 从「公司模型」正文解析合同分类和提取字段。
 * 要素名只来自模型里每个分类的模板节点，不在这里写死。
 */
const CONTRACT_ANCHOR = '合同';

function parseOutline(md) {
  const out = [];
  for (const raw of String(md || '').split('\n')) {
    const m = /^(\s*)-\s+(.*)$/.exec(raw);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, '  ').length;
    out.push({ level: Math.floor(indent / 2), text: m[2].trim() });
  }
  return out;
}

function directChildren(nodes, parentIdx) {
  const base = nodes[parentIdx].level;
  const out = [];
  for (let i = parentIdx + 1; i < nodes.length && nodes[i].level > base; i++) {
    if (nodes[i].level === base + 1) out.push({ idx: i, ...nodes[i] });
  }
  return out;
}

function findStructural(nodes, matchText, validate) {
  for (let i = 0; i < nodes.length; i++) {
    if (!matchText(nodes[i].text)) continue;
    if (!validate || validate(i)) return i;
  }
  return -1;
}

function hasChildren(nodes, idx) {
  return directChildren(nodes, idx).length > 0;
}

function fieldValues(nodes, fieldIdx) {
  return directChildren(nodes, fieldIdx).map((child) => child.text).filter(Boolean);
}

/** 分类下第一个子节点是模板，其余是已提取的合同。 */
function elementsOf(nodes, branchIdx) {
  const kids = directChildren(nodes, branchIdx);
  if (!kids.length) return { template: null, elements: [], instances: [], records: [] };
  const template = kids[0];
  const elements = directChildren(nodes, template.idx).map((k) => k.text);
  const records = kids.slice(1).map((contract) => {
    const fields = {};
    for (const field of directChildren(nodes, contract.idx)) {
      fields[field.text] = fieldValues(nodes, field.idx);
    }
    return { name: contract.text, fields };
  });
  return {
    template: template.text,
    elements,
    instances: records.map((record) => record.name),
    records,
  };
}

function parseCompanyModel(markdown) {
  const nodes = parseOutline(markdown);
  const anchorIdx = findStructural(
    nodes,
    (text) => text === CONTRACT_ANCHOR,
    (i) => directChildren(nodes, i).some((child) => hasChildren(nodes, child.idx)),
  );
  if (anchorIdx < 0) {
    const err = new Error('在模型里没找到结构完整的「' + CONTRACT_ANCHOR + '」节点');
    err.code = 'MODEL_CONTRACT_MISSING';
    throw err;
  }
  const branches = directChildren(nodes, anchorIdx).map((branch) => {
    const parsed = elementsOf(nodes, branch.idx);
    return {
      分类: branch.text,
      模板节点: parsed.template,
      要素: parsed.elements,
      已有合同: parsed.instances,
      合同记录: parsed.records,
    };
  });
  return { nodes, branches };
}

function sameFieldSet(expected, actualKeys) {
  const a = [...expected].sort();
  const b = [...actualKeys].sort();
  if (a.length !== b.length) return false;
  return a.every((name, i) => name === b[i]);
}

module.exports = {
  CONTRACT_ANCHOR,
  parseOutline,
  directChildren,
  findStructural,
  hasChildren,
  parseCompanyModel,
  sameFieldSet,
};
