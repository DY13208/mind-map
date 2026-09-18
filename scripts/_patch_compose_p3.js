const fs = require('fs');
const p = 'docker-compose.yml';
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf('  knowledge-mcp:');
if (start < 0) { console.error('service not found'); process.exit(1); }
let end = s.indexOf('\nvolumes:', start);
if (end < 0) end = s.length;
// find next top-level key after knowledge-mcp — volumes at root
const block = s.slice(start, end);
console.log('--- old block head ---');
console.log(block.split(/\n/).slice(0, 40).join('\n'));

const neu = `  knowledge-mcp:
    user: "0:0"
    build:
      context: ./integrations/knowledge-mcp
      dockerfile: Dockerfile
    image: mind-map-knowledge-mcp:0.3.0
    environment:
      KNOWLEDGE_MCP_PORT: "18792"
      KNOWLEDGE_MCP_JWT_SECRET: \${KNOWLEDGE_MCP_JWT_SECRET}
      KNOWLEDGE_MCP_JWT_ISS: openclaw-liangce
      KNOWLEDGE_MCP_JWT_AUD: knowledge-mcp
      KNOWLEDGE_MCP_JWT_TTL_SEC: \${KNOWLEDGE_MCP_JWT_TTL_SEC:-180}
      PGHOST: postgres
      PGPORT: "5432"
      PGUSER: \${PGUSER:-postgres}
      PGPASSWORD: \${PGPASSWORD:-mindmap}
      PGDATABASE: \${PGDATABASE:-mind_map}
      KNOWLEDGE_ROOT: /data/knowledge
      OPENWIKI_ROOMS_ROOT: /data/openwiki/rooms
      OPENWIKI_JOBS_ROOT: /data/openwiki/jobs
      OPENWIKI_GLOBAL_CONCURRENCY: \${OPENWIKI_GLOBAL_CONCURRENCY:-2}
      DOCMOST_DATABASE_URL: \${DOCMOST_DATABASE_URL:-}
      DOCMOST_APP_SECRET: \${DOCMOST_APP_SECRET:-}
      DOCMOST_INTERNAL_URL: \${DOCMOST_INTERNAL_URL:-http://docmost:3000}
      KNOWLEDGE_MCP_AUDIT_LOG: /data/audit/knowledge-mcp.jsonl
    volumes:
      - ./knowledge:/data/knowledge:ro
      - ./data/openwiki/rooms:/data/openwiki/rooms
      - ./data/openwiki/jobs:/data/openwiki/jobs
      - knowledge-mcp-audit:/data/audit
    expose:
      - "18792"
    ports:
      - "127.0.0.1:\${KNOWLEDGE_MCP_PORT:-18792}:18792"
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:18792/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 15s
    restart: unless-stopped

`;

s = s.slice(0, start) + neu + s.slice(end);
if (!s.includes('knowledge-mcp-audit:')) {
  // ensure volume exists
}
fs.writeFileSync(p, s);
console.log('compose patched');
