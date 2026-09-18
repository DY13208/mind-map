const fs = require('fs')

function patchCanonical() {
  const p = 'integrations/knowledge-mcp/src/adapters/canonical.js'
  let c = fs.readFileSync(p, 'utf8')
  if (c.includes("source_unavailable:canonical")) { console.log('canonical already'); return }
  const re = /async function canonicalList\([^)]*\)\s*\{/
  if (!re.test(c)) throw new Error('canonicalList missing')
  c = c.replace(re, (m) => m + `
  const rootCheck = knowledgeRoot(env);
  try { fs.accessSync(rootCheck, fs.constants.R_OK); } catch (e) {
    const err = new Error('source_unavailable:canonical');
    err.code = 'source_unavailable'; err.source = 'canonical'; throw err;
  }`)
  // remove later duplicate root const if we introduced double declaration — rename later uses
  fs.writeFileSync(p, c)
  console.log('canonical ok')
}

function patchOpenwiki() {
  const p = 'integrations/knowledge-mcp/src/adapters/openwiki.js'
  let o = fs.readFileSync(p, 'utf8')
  if (o.includes('source_unavailable:openwiki')) { console.log('openwiki already'); return }
  const re = /async function openwikiSearch\([^)]*\)\s*\{/
  if (!re.test(o)) throw new Error('openwikiSearch missing')
  o = o.replace(re, (m) => m + `
  const root = process.env.OPENWIKI_ROOMS_ROOT || '/data/openwiki/rooms';
  try { require('fs').accessSync(root, require('fs').constants.R_OK); } catch (e) {
    const err = new Error('source_unavailable:openwiki');
    err.code = 'source_unavailable'; err.source = 'openwiki'; throw err;
  }`)
  fs.writeFileSync(p, o)
  console.log('openwiki ok')
}

function patchDocmost() {
  const p = 'integrations/knowledge-mcp/src/adapters/docmost.js'
  let d = fs.readFileSync(p, 'utf8')
  if (d.includes('source_unavailable:docmost')) { console.log('docmost already'); return }
  const re = /async function docmostSearch\([^)]*\)\s*\{/
  if (!re.test(d)) throw new Error('docmostSearch missing')
  d = d.replace(re, (m) => m + '\n  try {')
  // Close try before last closing brace of function: find return rows.map and wrap
  if (!d.includes('return rows.map(mapRow);')) {
    // try mapRow alternate
    if (d.includes('return rows.map(mapRow)')) {
      d = d.replace('return rows.map(mapRow);', `return rows.map(mapRow);
  } catch (e) {
    if (e && (e.code === 'not_found' || e.code === 'acl_unavailable' || e.code === 'forbidden_write' || e.code === 'source_unavailable')) throw e;
    const err = new Error('source_unavailable:docmost');
    err.code = 'source_unavailable'; err.source = 'docmost'; err.cause = e; throw err;
  }`)
    } else throw new Error('docmost return missing')
  } else {
    d = d.replace('return rows.map(mapRow);', `return rows.map(mapRow);
  } catch (e) {
    if (e && (e.code === 'not_found' || e.code === 'acl_unavailable' || e.code === 'forbidden_write' || e.code === 'source_unavailable')) throw e;
    const err = new Error('source_unavailable:docmost');
    err.code = 'source_unavailable'; err.source = 'docmost'; err.cause = e; throw err;
  }`)
  }
  fs.writeFileSync(p, d)
  console.log('docmost ok')
}

patchCanonical();
patchOpenwiki();
patchDocmost();
for (const f of ['canonical.js','openwiki.js','docmost.js','../acl/rooms.js']) {
  require('child_process').execSync('node --check integrations/knowledge-mcp/src/' + (f.startsWith('..') ? 'acl/rooms.js' : 'adapters/' + f), { stdio: 'inherit' })
}
