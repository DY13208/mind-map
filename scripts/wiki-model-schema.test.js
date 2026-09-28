const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCompanyModel, sameFieldSet } = require('./wiki-model-schema');

const SAMPLE = `
- 知识
- 合同
  - 直播推广
    - 合同一
      - 合同双方
      - 预付款
    - 胡可合同
      - 合同双方
        - 甲方：依然电商
      - 预付款
        - 直播前 2 日付清
  - 分销
    - 合同一
      - 合同双方
- 别的合同
  - 不应被当成分类
`;

test('reads categories and template fields from the contract container', () => {
  const { branches } = parseCompanyModel(SAMPLE);
  assert.deepEqual(branches.map((b) => b.分类), ['直播推广', '分销']);
  assert.deepEqual(branches[0].要素, ['合同双方', '预付款']);
  assert.deepEqual(branches[0].已有合同, ['胡可合同']);
  assert.deepEqual(branches[0].合同记录[0].fields['合同双方'], ['甲方：依然电商']);
  assert.deepEqual(branches[1].已有合同, []);
});

test('ignores a short stub that has no nested contract template', () => {
  assert.throws(() => parseCompanyModel('- 知识\n- [合同](/p/abc)\n'), /合同/);
});

test('field set comparison ignores order', () => {
  assert.equal(sameFieldSet(['合同双方', '预付款'], ['预付款', '合同双方']), true);
  assert.equal(sameFieldSet(['合同双方', '预付款'], ['合同双方']), false);
});
