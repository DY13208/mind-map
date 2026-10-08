'use strict';

// Shared compiled company Wiki, matching the graph page's data scope.
// Authentication, rate limiting and audit are enforced by the MCP server.
function fail(code) {
  return Object.assign(new Error(code), { code });
}

async function wikiCompilerCall(userId, operation, args = {}, env = process.env) {
  if (!userId) throw fail('unauthorized');
  let endpoint;
  let body;
  switch (operation) {
    case 'graph': endpoint = 'api/graph'; break;
    case 'search': {
      if (typeof args.query !== 'string' || !args.query.trim()) throw fail('query_required');
      if (args.mode != null && !['business', 'demo'].includes(args.mode)) throw fail('invalid_mode');
      if (args.top_k != null && (!Number.isInteger(args.top_k) || args.top_k < 1 || args.top_k > 50)) throw fail('invalid_top_k');
      endpoint = 'api/search';
      body = { query: args.query.trim(), top_k: args.top_k, mode: args.mode || 'business' };
      break;
    }
    case 'topic':
    case 'concept':
      if (typeof args.slug !== 'string' || !args.slug.trim() || args.slug.length > 256 || /[\\/\x00-\x1f]/.test(args.slug) || ['.', '..'].includes(args.slug)) throw fail('invalid_slug');
      endpoint = `api/${operation}/${encodeURIComponent(args.slug)}`;
      break;
    default: throw fail('unknown_tool');
  }
  let base;
  try {
    base = new URL(env.WIKI_COMPILER_API_URL || 'http://wiki-graph:3848/');
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error();
    base.pathname = base.pathname.replace(/\/?$/, '/');
  } catch (_) { throw fail('wiki_compiler_unconfigured'); }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(new URL(endpoint, base), {
      method: body ? 'POST' : 'GET',
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) throw fail(response.status === 404 ? 'not_found' : 'wiki_compiler_unavailable');
    // Bound streamed responses as well as declared Content-Length.
    const maxBytes = 8 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > maxBytes) throw fail('wiki_compiler_response_too_large');
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) {
        controller.abort();
        throw fail('wiki_compiler_response_too_large');
      }
      chunks.push(Buffer.from(chunk));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch (_) { throw fail('wiki_compiler_invalid_response'); }
  } catch (error) {
    if (['not_found', 'wiki_compiler_unavailable', 'wiki_compiler_response_too_large', 'wiki_compiler_invalid_response'].includes(error.code)) throw error;
    throw fail(controller.signal.aborted ? 'wiki_compiler_timeout' : 'wiki_compiler_unavailable');
  } finally { clearTimeout(timeout); }
}

const TOOLS = [
  { name: 'wiki_compiler_graph', description: 'Read the shared compiled company Wiki graph: topics, concepts and relationships. Read-only; not room-scoped.', inputSchema: { type: 'object', properties: {} } },
  { name: 'wiki_compiler_search', description: 'Search sections in the shared compiled company Wiki. Business mode excludes demo sources. Read-only; not Docmost or room-scoped OpenWiki.', inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, top_k: { type: 'integer', minimum: 1, maximum: 50 }, mode: { type: 'string', enum: ['business', 'demo'], default: 'business' } }, required: ['query'] } },
  ...['topic', 'concept'].map(type => ({ name: `wiki_compiler_${type}`, description: `Read a ${type} article from the shared compiled company Wiki by slug obtained from graph or search. Read-only; not room-scoped.`, inputSchema: { type: 'object', properties: { slug: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['slug'] } })),
];

module.exports = { wikiCompilerCall, TOOLS };
