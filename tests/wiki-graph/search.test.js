const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { searchWiki, handleSearch, loadTopicArticle, wikiProvenance } = require('../../integrations/wiki-graph/server.cjs');

const FIXTURE = path.join(__dirname, 'fixtures');

function search(query, top_k) {
  return searchWiki(FIXTURE, { query, top_k });
}

test('exact topic query hits 直播推广', () => {
  const payload = search('直播推广');
  assert.ok(payload.results.length > 0);
  assert.ok(payload.results.every(item => item.topic === '直播推广'));
});

test('佣金 query prefers the section that contains it', () => {
  const payload = search('直播推广佣金');
  assert.equal(payload.results[0].topic, '直播推广');
  assert.equal(payload.results[0].section, '预付款');
  assert.match(payload.results[0].content, /佣金/);
});

test('natural language query hits 胡可, 直播推广 and 佣金', () => {
  const payload = search('胡可的直播推广佣金怎么算？');
  const top = payload.results[0];
  assert.equal(top.topic, '直播推广');
  assert.match(top.content, /胡可/);
  assert.match(top.content, /佣金/);
});

test('unknown query returns an empty list', () => {
  const payload = search('公司员工宿舍补贴');
  assert.deepEqual(payload.results, []);
});

test('old topic outside compile state is not searchable', () => {
  const payload = search('合作模式');
  assert.deepEqual(payload.results, []);
});

test('old concept outside compile state is not searchable', () => {
  const payload = search('甲方主体穿透');
  assert.deepEqual(payload.results, []);
});

test('ranking is stable across repeats', () => {
  const first = JSON.stringify(search('直播推广佣金'));
  const second = JSON.stringify(search('直播推广佣金'));
  const third = JSON.stringify(search('胡可的直播推广佣金怎么算？'));
  const fourth = JSON.stringify(search('胡可的直播推广佣金怎么算？'));
  assert.equal(first, second);
  assert.equal(third, fourth);
});

test('top_k limits the result size', () => {
  assert.equal(search('直播推广', 1).results.length, 1);
  assert.ok(search('直播推广', 5).results.length <= 5);
  assert.ok(search('直播推广', 8).results.length <= 8);
  assert.equal(search('直播推广', 1).results[0].topic, '直播推广');
});

test('source lines are returned and missing sources stay empty', () => {
  const hit = search('直播推广佣金').results[0];
  assert.deepEqual(hit.source, ['胡可直播业务合同-still0730.docx']);
  const emptySource = search('品牌经销').results[0];
  assert.equal(emptySource.topic, '品牌经销');
  assert.deepEqual(emptySource.source, []);
});

test('chunk_id and version stay stable', () => {
  const a = search('直播推广佣金').results[0];
  const b = search('直播推广佣金').results[0];
  assert.equal(a.chunk_id, b.chunk_id);
  assert.match(a.chunk_id, /^直播推广::预付款::\d+$/);
  assert.equal(a.version, '2026-09-28');
});

test('blank query is rejected by the search wrapper', () => {
  const { handleSearch } = require('../../integrations/wiki-graph/server.cjs');
  const missing = handleSearch(FIXTURE, {});
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body, { error: 'query is required' });
});

test('provenance only labels explicitly marked business sources and reserves local-verify for demo', () => {
  assert.deepEqual(wikiProvenance({ pageId: 'local-verify', title: '本地验证' }, { provenance: 'business' }), {
    origin: 'demo', sourceTitle: '本地验证', sourceId: 'local-verify'
  });
  assert.deepEqual(wikiProvenance({ id: 'corp-wiki', title: '业务 Wiki', provenance: 'business' }), {
    origin: 'business', sourceTitle: '业务 Wiki', sourceId: 'corp-wiki'
  });
  assert.deepEqual(wikiProvenance({ title: '未标注来源' }), {
    origin: 'unknown', sourceTitle: '未标注来源', sourceId: ''
  });
});

test('business search excludes local verification content while demo search exposes its provenance', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-check-provenance-'));
  try {
    fs.cpSync(FIXTURE, temp, { recursive: true });
    const statePath = path.join(temp, '.compile-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.source = { pageId: 'local-verify', title: '本地验收数据' };
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');

    const business = handleSearch(temp, { query: '直播推广', mode: 'business' });
    const demo = handleSearch(temp, { query: '直播推广', mode: 'demo' });
    assert.equal(business.status, 200);
    assert.deepEqual(business.body.results, []);
    assert.equal(demo.status, 200);
    assert.ok(demo.body.results.length > 0);
    assert.deepEqual(demo.body.results[0].provenance, {
      origin: 'demo', sourceTitle: '本地验收数据', sourceId: 'local-verify'
    });

    const topic = loadTopicArticle(temp, '直播推广');
    assert.equal(topic.provenance.origin, 'demo');
    assert.equal(topic.provenance.sourceTitle, '本地验收数据');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('invalid search mode is rejected instead of silently broadening the source set', () => {
  assert.deepEqual(handleSearch(FIXTURE, { query: '直播推广', mode: 'all' }), {
    status: 400, body: { error: 'mode must be business or demo' }
  });
});

test('topic API helper reports unknown provenance when the compile state has no explicit source marker', () => {
  const topic = loadTopicArticle(FIXTURE, '直播推广');
  assert.deepEqual(topic.provenance, { origin: 'unknown', sourceTitle: '', sourceId: '' });
});
