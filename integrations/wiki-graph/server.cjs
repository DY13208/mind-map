#!/usr/bin/env node
// Wiki Knowledge Graph — Visualization Server
// Zero dependencies. Parses compiled wiki markdown and serves JSON API.
// Usage: node server.js --wiki-dir path/to/wiki/

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3848);

// Parse CLI args
let wikiDir = process.env.WIKI_DIR || null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--wiki-dir' && process.argv[i + 1]) {
    wikiDir = path.resolve(process.argv[i + 1]);
    i++;
  }
}

if (!wikiDir) {
  // Try to find wiki dir from .wiki-compiler.json in cwd
  const configPath = path.join(process.cwd(), '.wiki-compiler.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    wikiDir = path.resolve(process.cwd(), config.output || 'wiki/');
  }
}

if (require.main === module && (!wikiDir || !fs.existsSync(wikiDir))) {
  console.error('Usage: node server.js --wiki-dir path/to/wiki/');
  console.error('  Or run from a directory with .wiki-compiler.json');
  process.exit(1);
}

if (require.main === module) console.log(`📚 Wiki dir: ${wikiDir}`);

// --- Markdown Parsing ---

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };
  const meta = {};
  match[1].split('\n').forEach(line => {
    const m = line.match(/^(\w[\w_]*)\s*:\s*(.+)$/);
    if (m) {
      let val = m[2].trim();
      if (val.startsWith('[') && val.endsWith(']')) {
        val = val.slice(1, -1).split(',').map(s => s.trim().replace(/"/g, ''));
      }
      meta[m[1]] = val;
    }
  });
  return { meta, body: match[2] };
}

function parseIndexTopics(indexContent) {
  const topics = [];
  const lines = indexContent.split('\n');
  let inTopicTable = false;
  for (const line of lines) {
    if (line.includes('| Topic |')) { inTopicTable = true; continue; }
    if (inTopicTable && line.match(/^\|[-\s|]+\|$/)) continue;
    if (inTopicTable && line.startsWith('|')) {
      const cols = line.split('|').map(s => s.trim()).filter(Boolean);
      if (cols.length >= 2) {
        // Markdown link: [name](path.md)
        let linkMatch = cols[0].match(/\[([^\]]+)\]\(([^)]+)\)/);
        let name, slug;
        if (linkMatch) {
          name = linkMatch[1];
          slug = path.basename(linkMatch[2], '.md');
        } else {
          // Obsidian wikilink: [[topics/slug]] or [[slug]]
          const wikiMatch = cols[0].match(/\[\[([^\]]+)\]\]/);
          if (wikiMatch) {
            const target = wikiMatch[1];
            slug = path.basename(target);
            name = slug;
          }
        }
        if (slug) {
          topics.push({
            slug,
            name,
            aliases: cols.length >= 4 ? cols[1] : '',
            sourceCount: parseInt(cols.length >= 4 ? cols[2] : cols[1]) || 0,
            lastUpdated: cols.length >= 4 ? cols[3] : '',
            status: cols.length >= 5 ? cols[4] : 'active'
          });
        }
      }
    } else if (inTopicTable && !line.startsWith('|')) {
      inTopicTable = false;
    }
  }
  return topics;
}

function parseSections(body) {
  const sections = [];
  const lines = body.split('\n');
  let currentSection = null;
  let currentContent = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (currentSection) {
        sections.push({ heading: currentSection, content: currentContent.join('\n').trim() });
      }
      currentSection = line.slice(3).trim();
      currentContent = [];
    } else if (currentSection) {
      currentContent.push(line);
    }
  }
  if (currentSection) {
    sections.push({ heading: currentSection, content: currentContent.join('\n').trim() });
  }
  return sections;
}

// Extract source paths from the Sources section of an article body.
// Handles both Obsidian wikilinks [[path/to/file]] and markdown links [text](path.md).
function extractSourcePaths(body) {
  const sourcesSection = body.match(/\n## Sources[^\n]*\n([\s\S]*?)(?:\n## |\n---|\n$|$)/i);
  if (!sourcesSection) return [];
  const text = sourcesSection[1];
  const paths = new Set();
  // Obsidian wikilinks: [[path]] or [[path|label]]
  for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    paths.add(m[1].trim());
  }
  // Markdown links: [text](path)
  for (const m of text.matchAll(/\[[^\]]+\]\(([^)]+\.md)\)/g)) {
    paths.add(m[1].trim());
  }
  return Array.from(paths);
}

// --- Data Loading ---

function loadGraph() {
  const indexPath = path.join(wikiDir, 'INDEX.md');
  if (!fs.existsSync(indexPath)) return { name: 'Unknown', topics: [], concepts: [], edges: [] };

  const indexContent = fs.readFileSync(indexPath, 'utf8');

  // Extract wiki name from first heading
  const nameMatch = indexContent.match(/^# (.+)/m);
  const name = nameMatch ? nameMatch[1].replace(' Knowledge Base', '') : 'Wiki';

  // Extract stats（INDEX 里 topics 与 sources 之间可能有 concepts 段，故用 [^\n]* 兜住）
  const statsMatch = indexContent.match(/Total topics: (\d+)[^\n]*?Total sources: (\d+)/);
  const totalTopics = statsMatch ? parseInt(statsMatch[1]) : 0;
  const totalSources = statsMatch ? parseInt(statsMatch[2]) : 0;

  // Parse topics from table
  const topics = parseIndexTopics(indexContent);

  // Load each topic's sources list to enable shared-source fallback edges
  // for topics without concept coverage.
  const topicSources = {}; // slug -> Set<sourcePath>
  const topicsDir = path.join(wikiDir, 'topics');
  if (fs.existsSync(topicsDir)) {
    for (const topic of topics) {
      const topicPath = path.join(topicsDir, `${topic.slug}.md`);
      if (fs.existsSync(topicPath)) {
        const content = fs.readFileSync(topicPath, 'utf8');
        const { body } = parseFrontmatter(content);
        topicSources[topic.slug] = new Set(extractSourcePaths(body));
      } else {
        topicSources[topic.slug] = new Set();
      }
    }
  }

  // Parse concepts
  const concepts = [];
  const edges = [];
  const conceptEdgeKeys = new Set(); // dedupe for shared-source pass
  const conceptsDir = path.join(wikiDir, 'concepts');
  if (fs.existsSync(conceptsDir)) {
    const conceptFiles = fs.readdirSync(conceptsDir).filter(f => f.endsWith('.md'));
    for (const file of conceptFiles) {
      const content = fs.readFileSync(path.join(conceptsDir, file), 'utf8');
      const { meta } = parseFrontmatter(content);
      const slug = path.basename(file, '.md');
      const connects = Array.isArray(meta.topics_connected) ? meta.topics_connected : [];
      concepts.push({ slug, name: meta.concept || slug, connects });

      // Build edges: every pair of connected topics
      for (let i = 0; i < connects.length; i++) {
        for (let j = i + 1; j < connects.length; j++) {
          const [a, b] = [connects[i], connects[j]].sort();
          edges.push({ from: connects[i], to: connects[j], concept: slug, type: 'concept' });
          conceptEdgeKeys.add(`${a}|${b}`);
        }
      }
    }
  }

  // Fallback edges for topics without concept coverage. Two sources:
  //  (a) topic-to-topic references: when topic A's Sources section wikilinks
  //      to another topic (e.g., ai-architecture cites [[inspiration-bookmarks]]).
  //  (b) shared external sources: two topics sharing >=N source file paths.
  const SHARED_SOURCE_THRESHOLD = 3;
  const topicSlugSet = new Set(Object.keys(topicSources));
  const sharedEdges = new Map(); // key -> {from,to,count,reason}
  const addSharedEdge = (a, b, count, reason) => {
    if (a === b) return;
    const [x, y] = [a, b].sort();
    const key = `${x}|${y}`;
    if (conceptEdgeKeys.has(key)) return;
    const existing = sharedEdges.get(key);
    if (!existing || count > existing.count) {
      sharedEdges.set(key, { from: a, to: b, count, reason });
    }
  };

  // (a) topic-to-topic references via Sources section
  for (const [slug, sources] of Object.entries(topicSources)) {
    for (const src of sources) {
      // Extract tail slug from paths like "inspiration-bookmarks" or "topics/foo" or "../topics/foo"
      const tail = src.replace(/\.md$/, '').split('/').pop();
      if (tail && tail !== slug && topicSlugSet.has(tail)) {
        addSharedEdge(slug, tail, 1, 'topic-ref');
      }
    }
  }

  // (b) shared external source paths
  const topicSlugs = Object.keys(topicSources);
  for (let i = 0; i < topicSlugs.length; i++) {
    for (let j = i + 1; j < topicSlugs.length; j++) {
      const a = topicSlugs[i];
      const b = topicSlugs[j];
      const setA = topicSources[a];
      const setB = topicSources[b];
      if (!setA || !setB || setA.size === 0 || setB.size === 0) continue;
      let shared = 0;
      const smaller = setA.size <= setB.size ? setA : setB;
      const larger = setA.size <= setB.size ? setB : setA;
      for (const p of smaller) { if (larger.has(p)) shared++; }
      if (shared >= SHARED_SOURCE_THRESHOLD) {
        addSharedEdge(a, b, shared, 'shared-sources');
      }
    }
  }

  for (const e of sharedEdges.values()) {
    edges.push({ from: e.from, to: e.to, concept: null, type: 'shared', sharedCount: e.count, reason: e.reason });
  }

  return { name, totalTopics, totalSources, topics, concepts, edges };
}

function loadArticle(type, slug, dir = wikiDir) {
  if (!slug || slug === '.' || slug === '..' || /[\\/\0]/.test(slug)) return null;
  const contentDir = type === 'concept' ? 'concepts' : 'topics';
  const filePath = path.join(dir, contentDir, `${slug}.md`);
  if (!fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, 'utf8');
  const { meta, body } = parseFrontmatter(content);
  const sections = parseSections(body);

  // Extract title from first heading
  const titleMatch = body.match(/^# (.+)/m);
  const title = titleMatch ? titleMatch[1] : slug;

  return { slug, title, meta, sections };
}

function wikiProvenance(source = {}, articleMeta = {}) {
  const pageId = String(source.pageId || source.sourceId || source.id || '').trim();
  const explicit = [
    articleMeta.provenance,
    articleMeta.source_provenance,
    articleMeta.source_origin,
    source.provenance,
    source.origin
  ].map(value => String(value || '').trim().toLowerCase());
  // This id is reserved by the compiler workflow for local verification
  // content. It must remain demo even if a copied article contains a marker.
  const origin = pageId === 'local-verify' || explicit.includes('demo')
    ? 'demo'
    : explicit.includes('business') ? 'business' : 'unknown';
  const sourceTitle = String(
    source.title || source.sourceTitle || source.name || articleMeta.source_title || articleMeta.sourceTitle || ''
  ).trim();
  return { origin, sourceTitle, sourceId: pageId || String(articleMeta.source_id || '').trim() };
}

function articleProvenance(dir, article) {
  const state = readJson(path.join(dir, '.compile-state.json')) || {};
  return wikiProvenance(state.source || {}, article && article.meta || {});
}

function loadTopicArticle(dir, slug) {
  const article = loadArticle('topic', slug, dir);
  if (!article) return null;
  article.provenance = articleProvenance(dir, article);
  return article;
}

// --- HTTP Server ---

// Browser percent-encodes non-ASCII slugs (e.g. Chinese filenames);
// decode before mapping to file paths, else fs lookups 404.
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

const STOPWORDS = ['有哪些', '是否', '可以', '相关', '请问', '怎么', '什么', '的', '是'];
const TOP_K_DEFAULT = 8;
const TOP_K_MAX = 50;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return null;
  }
}

function displayHeading(heading) {
  return String(heading || '').replace(/\s*\[coverage:[^\]]*\]\s*$/i, '').trim();
}

function loadCurrentWiki(dir, allowedRooms) {
  if (allowedRooms) return loadRoomWiki(dir, allowedRooms);
  const state = readJson(path.join(dir, '.compile-state.json')) || {};
  const source = state.source && typeof state.source === 'object' ? state.source : {};
  const indexPath = path.join(dir, 'INDEX.md');
  const indexTopics = fs.existsSync(indexPath)
    ? parseIndexTopics(fs.readFileSync(indexPath, 'utf8'))
    : [];
  const allowedTopics = new Set((state.topics || []).map(String));
  const allowedConcepts = new Set((state.concepts || []).map(String));
  const topics = [];
  for (const topic of indexTopics) {
    if (!allowedTopics.has(topic.slug) && !allowedTopics.has(topic.name)) continue;
    const filePath = path.join(dir, 'topics', topic.slug + '.md');
    if (!fs.existsSync(filePath)) continue;
    const raw = fs.readFileSync(filePath, 'utf8');
    const { body, meta } = parseFrontmatter(raw);
    const lines = body.split('\n');
    const sections = [];
    let heading = null;
    let startLine = 0;
    let buf = [];
    const flush = () => {
      if (!heading) return;
      sections.push({
        heading: displayHeading(heading),
        content: buf.join('\n').trim(),
        startLine
      });
    };
    lines.forEach((line, index) => {
      if (line.startsWith('## ')) {
        flush();
        heading = line.slice(3).trim();
        startLine = index + 1;
        buf = [];
      } else if (heading) {
        buf.push(line);
      }
    });
    flush();
    const sources = (sections.find(section => /^sources$/i.test(section.heading)) || { content: '' })
      .content.split('\n')
      .map(line => line.replace(/^\s*[-*]\s+/, '').trim())
      .filter(Boolean);
    topics.push({
      name: topic.name || topic.slug,
      slug: topic.slug,
      provenance: wikiProvenance(source, meta),
      sections: sections.filter(section => !/^sources$/i.test(section.heading)),
      sources
    });
  }
  const concepts = [];
  for (const name of allowedConcepts) {
    const filePath = path.join(dir, 'concepts', name + '.md');
    if (!fs.existsSync(filePath)) continue;
    const { meta, body } = parseFrontmatter(fs.readFileSync(filePath, 'utf8'));
    concepts.push({
      name: meta.concept || name,
      connects: Array.isArray(meta.topics_connected) ? meta.topics_connected.map(String) : [],
      body
    });
  }
  const currentNames = new Set(topics.map(topic => topic.name));
  const edges = [];
  for (const concept of concepts) {
    const ends = concept.connects.filter(name => currentNames.has(name));
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        edges.push([ends[i], ends[j]]);
      }
    }
  }
  return {
    version: state.last_compiled ? String(state.last_compiled) : '',
    topics,
    concepts,
    edges
  };
}

function knownPhrases(wiki) {
  const phrases = [];
  for (const topic of wiki.topics) phrases.push(topic.name);
  for (const concept of wiki.concepts) phrases.push(concept.name);
  for (const topic of wiki.topics) {
    for (const section of topic.sections) {
      if (section.heading) phrases.push(section.heading);
    }
  }
  return [...new Set(phrases.filter(Boolean))].sort((a, b) => b.length - a.length);
}

function tokenize(query, phrases) {
  const stripped = String(query || '').replace(/[\s,，.。!！?？、；;:：""''（）()【】[\]\-_/]+/g, '');
  const tokens = new Set();
  const stops = [...STOPWORDS].sort((a, b) => b.length - a.length);
  const MAX_TOKENS = 120;
  let rest = stripped;
  while (rest) {
    const phrase = phrases.find(item => rest.startsWith(item));
    if (phrase) {
      tokens.add(phrase);
      rest = rest.slice(phrase.length);
      continue;
    }
    const stop = stops.find(item => rest.startsWith(item));
    if (stop) {
      rest = rest.slice(stop.length);
      continue;
    }
    let end = 1;
    while (end < rest.length) {
      const tail = rest.slice(end);
      if (phrases.some(item => tail.startsWith(item)) || stops.some(item => tail.startsWith(item))) break;
      end += 1;
    }
    const chunk = rest.slice(0, end);
    if (chunk.length >= 2 && chunk.length <= 8) {
      tokens.add(chunk);
    } else if (chunk.length > 8) {
      // Long runs of concatenated phrases (e.g. a check-button query with a
      // D title plus several field labels) used to be dropped entirely. Fall
      // back to 2-char sliding windows so short field terms still match.
      for (let i = 0; i + 2 <= chunk.length; i += 1) {
        tokens.add(chunk.slice(i, i + 2));
        if (tokens.size >= MAX_TOKENS) break;
      }
    }
    rest = rest.slice(end);
    if (tokens.size >= MAX_TOKENS) break;
  }
  return [...tokens];
}

function sectionScore(tokens, topicName, heading, content) {
  let score = 0;
  const matched = [];
  if (tokens.includes(topicName)) {
    score += 100;
    matched.push(topicName);
  } else if (tokens.some(token => topicName.includes(token))) {
    score += 40;
  }
  if (tokens.includes(heading)) {
    score += 80;
    matched.push(heading);
  } else if (tokens.some(token => heading.includes(token))) {
    score += 30;
  }
  let bodyHits = 0;
  for (const token of tokens) {
    if (token.length < 2) continue;
    if (content.includes(token)) {
      bodyHits += 1;
      matched.push(token);
    }
  }
  score += bodyHits * 10;
  const uniqueHits = new Set(matched).size;
  if (uniqueHits > 1) score += 5 * (uniqueHits - 1);
  return score;
}

function clampTopK(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return TOP_K_DEFAULT;
  return Math.min(TOP_K_MAX, Math.max(1, Math.floor(num)));
}

function searchWiki(dir, options) {
  const query = String(options.query || '');
  const mode = options.mode === 'demo' ? 'demo' : 'business';
  const wiki = loadCurrentWiki(dir, options.allowedRooms);
  const tokens = tokenize(query, knownPhrases(wiki));
  const lexical = [];
  for (const topic of wiki.topics) {
    if (mode === 'business' && topic.provenance.origin === 'demo') continue;
    for (const section of topic.sections) {
      const score = sectionScore(tokens, topic.name, section.heading, section.content);
      if (score <= 0) continue;
      const searchable = `${topic.name} ${section.heading} ${section.content}`;
      const matchedTerms = tokens.filter(token => token.length >= 2 && searchable.includes(token));
      lexical.push({ topic, section, score, matchedTerms: [...new Set(matchedTerms)] });
    }
  }
  const hitTopics = new Set(lexical.map(item => item.topic.name));
  for (const item of lexical) {
    const near = wiki.edges.some(edge =>
      (edge[0] === item.topic.name && hitTopics.has(edge[1])) ||
      (edge[1] === item.topic.name && hitTopics.has(edge[0]))
    );
    if (near) item.score += 3;
  }
  lexical.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.topic.name !== b.topic.name) return a.topic.name < b.topic.name ? -1 : 1;
    if (a.section.startLine !== b.section.startLine) return a.section.startLine - b.section.startLine;
    return a.section.heading < b.section.heading ? -1 : 1;
  });
  const top = lexical.slice(0, clampTopK(options.top_k));
  return {
    query,
    version: wiki.version,
    results: top.map(item => ({
      chunk_id: (item.topic.roomId ? item.topic.slug : item.topic.name) + '::' + item.section.heading + '::' + item.section.startLine,
      score: item.score,
      topic: item.topic.roomId ? item.topic.slug : item.topic.name,
      topic_title: item.topic.name,
      section: item.section.heading,
      content: item.section.content,
      matched_terms: item.matchedTerms,
      concepts: wiki.concepts
        .filter(concept => concept.connects.includes(item.topic.name))
        .map(concept => concept.name),
      source: item.topic.sources,
      provenance: item.topic.provenance,
      version: wiki.version
    }))
  };
}

function handleSearch(dir, body) {
  const query = body && body.query != null ? String(body.query).trim() : '';
  if (!query) return { status: 400, body: { error: 'query is required' } };
  if (body.mode != null && !['business', 'demo'].includes(String(body.mode))) {
    return { status: 400, body: { error: 'mode must be business or demo' } };
  }
  return { status: 200, body: searchWiki(dir, { query, top_k: body.top_k, mode: body.mode, allowedRooms: body.allowedRooms }) };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function roomBundles(dir, allowedRooms) {
  const bundles = [];
  for (const roomId of [...allowedRooms].sort()) {
    if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,119}$/.test(roomId)) continue;
    const roomDir = path.join(dir, 'rooms', roomId);
    const pointer = readJson(path.join(roomDir, 'current.json'));
    if (!pointer || !/^[a-f0-9-]{36}$/.test(pointer.generation)) continue;
    const bundle = readJson(path.join(roomDir, 'generations', pointer.generation, 'bundle.json'));
    if (!bundle || bundle.roomId !== roomId || bundle.sourceHash !== pointer.sourceHash || !Array.isArray(bundle.topics)) continue;
    bundles.push(bundle);
  }
  return bundles;
}
function roomArticle(topic) {
  const body = topic.markdown.replace(/^# [^\n]*\n?/, '').trim();
  const markdown = '# ' + topic.title + '\n\n## 内容\n\n' + body;
  const sections = parseSections(markdown);
  const provenance = { origin: 'business', sourceTitle: topic.roomTitle, sourceId: topic.roomId,
    roomId: topic.roomId, nodeUid: topic.nodeUid, sourceVersion: topic.version,
    sourceRevision: topic.sourceRevision, contentHash: topic.contentHash, publishedAt: topic.publishedAt };
  return { slug: topic.slug, title: topic.roomTitle + ' / ' + topic.title,
    meta: { topic: topic.slug, room_id: topic.roomId, node_uid: topic.nodeUid, status: 'active',
      source_count: 1, last_compiled: topic.publishedAt }, sections, provenance, markdown };
}
function loadRoomWiki(dir, allowedRooms) {
  const bundles = roomBundles(dir, allowedRooms);
  const topics = [];
  for (const bundle of bundles) for (const topic of bundle.topics) {
    const article = roomArticle(topic);
    let startLine = 1;
    topics.push({ name: article.title, slug: topic.slug, roomId: topic.roomId,
      parentUid: topic.parentUid, nodeUid: topic.nodeUid, provenance: article.provenance,
      sections: article.sections.map(section => ({ ...section, startLine: startLine++ })),
      sources: [article.title] });
  }
  return { version: require('node:crypto').createHash('sha256').update(JSON.stringify(bundles.map(b => [b.roomId, b.sourceHash]))).digest('hex'), topics, concepts: [], edges: [] };
}
function roomGraph(dir, allowedRooms) {
  const wiki = loadRoomWiki(dir, allowedRooms);
  const topics = wiki.topics.map(t => ({ slug: t.slug, name: t.name, aliases: '', sourceCount: 1,
    lastUpdated: t.provenance.publishedAt, status: 'active', roomId: t.roomId, nodeUid: t.nodeUid, provenance: t.provenance }));
  const byNode = new Map(wiki.topics.map(t => [t.roomId + ':' + t.nodeUid, t.slug]));
  const edges = wiki.topics.filter(t => t.parentUid && byNode.has(t.roomId + ':' + t.parentUid))
    .map(t => ({ from: byNode.get(t.roomId + ':' + t.parentUid), to: t.slug, type: 'structure', concept: null }));
  return { name: '脑图知识库', version: wiki.version, totalTopics: topics.length, totalSources: allowedRooms.size, topics, concepts: [], edges };
}
function createWikiServer({ dir, pool, env = process.env }) {
  const { verifyIdentity, readableRooms } = require('../../simple-mind-map/bin/wikiCompiler/access');
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/health') return json(200, { status: 'ok' });
    if (url.pathname === '/interaction.js' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(path.join(__dirname, 'interaction.js'), 'utf8')); return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')); return;
    }
    if (!url.pathname.startsWith('/api/')) return json(404, { error: 'not_found' });
    try {
      const user = verifyIdentity(req.headers['x-wiki-compiler-identity'], env);
      const allowedRooms = await readableRooms(pool, user, env);
      if (url.pathname === '/api/search' && req.method === 'POST') {
        const raw = await readRequestBody(req);
        const body = JSON.parse(raw || '{}');
        const result = handleSearch(dir, { ...body, allowedRooms });
        return json(result.status, result.body);
      }
      if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
      if (url.pathname === '/api/graph') return json(200, roomGraph(dir, allowedRooms));
      if (url.pathname.startsWith('/api/topic/')) {
        const slug = safeDecode(url.pathname.slice('/api/topic/'.length));
        const topic = roomBundles(dir, allowedRooms).flatMap(b => b.topics).find(t => t.slug === slug);
        return topic ? json(200, roomArticle(topic)) : json(404, { error: 'not_found' });
      }
      if (url.pathname.startsWith('/api/concept/')) return json(404, { error: 'not_found' });
      return json(404, { error: 'not_found' });
    } catch (error) {
      const status = error.code === 'unauthorized' ? 401 : error instanceof SyntaxError ? 400 : 503;
      return json(status, { error: status === 401 ? 'unauthorized' : status === 400 ? 'invalid_json' : 'wiki_compiler_unavailable' });
    }
  });
}
if (require.main === module) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.MIND_MAP_DATABASE_URL || process.env.DATABASE_URL || undefined,
    connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  const server = createWikiServer({ dir: wikiDir, pool });
  server.listen(PORT, '0.0.0.0', () => console.log('Wiki compiler listening on ' + PORT));
}
module.exports = { searchWiki, tokenize, loadCurrentWiki, handleSearch, wikiProvenance, loadTopicArticle,
  createWikiServer, loadRoomWiki, roomGraph, roomBundles };
