const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeContractSpec } = require('./wiki-compile-model');

function liveCategories() {
  return [{
    分类: '直播推广',
    模板节点: '合同一',
    要素: ['合同双方', '预付款'],
    已有合同: [],
    合同记录: [],
  }];
}

test('a category outside the model is written as its own topic', () => {
  const categories = liveCategories();
  const result = mergeContractSpec(categories, {
    contract: '股权代持协议',
    category: '股权',
    elements: { 代持方: ['甲'], 被代持方: ['乙'] },
  }, 'equity.json');
  assert.deepEqual(result.created, ['股权']);
  assert.deepEqual(result.added, ['股权代持协议']);
  assert.equal(result.skipped.length, 0);
  const topic = categories.find((item) => item.分类 === '股权');
  assert.deepEqual(topic.要素, ['代持方', '被代持方']);
  assert.deepEqual(topic.合同记录[0].fields['代持方'], ['甲']);
});

test('extra fields on a known category are kept and written', () => {
  const categories = liveCategories();
  mergeContractSpec(categories, {
    contract: '新直播合同',
    category: '直播推广',
    elements: { 合同双方: ['甲方'], 附加条款: ['补充'] },
  }, 'new.json');
  const topic = categories[0];
  assert.deepEqual(topic.要素, ['合同双方', '预付款', '附加条款']);
  assert.deepEqual(topic.已有合同, ['新直播合同']);
  assert.deepEqual(topic.合同记录[0].fields['附加条款'], ['补充']);
  assert.deepEqual(topic.合同记录[0].fields['预付款'], []);
});
