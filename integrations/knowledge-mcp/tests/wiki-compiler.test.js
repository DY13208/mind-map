'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { verifyIdentity } = require('../../../simple-mind-map/bin/wikiCompiler/access');
const { wikiCompilerCall, TOOLS } = require('../src/adapters/wikiCompiler');

test('compiler tools advertise four read-only operations', () => {
  assert.deepEqual(TOOLS.map(t => t.name), ['wiki_compiler_graph', 'wiki_compiler_search', 'wiki_compiler_topic', 'wiki_compiler_concept']);
});

test('rejects unauthenticated callers and invalid parameters before fetching', async () => {
  for (const [user, op, args, code] of [
    ['', 'graph', {}, 'unauthorized'],
    ['u', 'search', { query: '' }, 'query_required'],
    ['u', 'search', { query: 'x', mode: 'all' }, 'invalid_mode'],
    ['u', 'search', { query: 'x', top_k: 51 }, 'invalid_top_k'],
    ['u', 'topic', { slug: '../private' }, 'invalid_slug'],
    ['u', 'concept', { slug: '..' }, 'invalid_slug'],
  ]) await assert.rejects(wikiCompilerCall(user, op, args), { code });
});

test('routes graph/search/articles through a configured prefix and preserves results', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    assert.equal(verifyIdentity(req.headers['x-wiki-compiler-identity'], { WIKI_COMPILER_INTERNAL_SECRET: 't'.repeat(64) }), 'u');
    requests.push({ path: req.url, method: req.method, body: raw ? JSON.parse(raw) : null });
    if (req.url.endsWith('/missing')) { res.writeHead(404); return res.end(); }
    if (req.url.endsWith('/broken')) return res.end('bad json');
    if (req.url.endsWith('/huge')) { res.writeHead(200, { 'content-length': '9000000' }); return res.end(); }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ sections: [{ content: '正文', hash: 'abc' }], provenance: { origin: 'business' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { WIKI_COMPILER_INTERNAL_SECRET: 't'.repeat(64), WIKI_COMPILER_API_URL: `http://127.0.0.1:${server.address().port}/wiki-compiler` };
  for (const op of ['graph', 'search', 'topic', 'concept']) {
    const result = await wikiCompilerCall('u', op, { query: '合同', slug: '合同 规则', top_k: 3 }, env);
    assert.equal(result.sections[0].content, '正文');
    assert.equal(result.provenance.origin, 'business');
  }
  assert.deepEqual(requests.map(r => r.path), ['/wiki-compiler/api/graph', '/wiki-compiler/api/search', '/wiki-compiler/api/topic/%E5%90%88%E5%90%8C%20%E8%A7%84%E5%88%99', '/wiki-compiler/api/concept/%E5%90%88%E5%90%8C%20%E8%A7%84%E5%88%99']);
  assert.deepEqual(requests[1].body, { query: '合同', top_k: 3, mode: 'business' });
  for (const [slug, code] of [['missing', 'not_found'], ['broken', 'wiki_compiler_invalid_response'], ['huge', 'wiki_compiler_response_too_large']]) {
    await assert.rejects(wikiCompilerCall('u', 'topic', { slug }, env), { code });
  }
});

test('configuration rejects credentials and non-HTTP schemes', async () => {
  for (const url of ['file:///tmp/wiki', 'http://user:pass@localhost']) {
    await assert.rejects(wikiCompilerCall('u', 'graph', {}, { WIKI_COMPILER_API_URL: url }), { code: 'wiki_compiler_unconfigured' });
  }
});
