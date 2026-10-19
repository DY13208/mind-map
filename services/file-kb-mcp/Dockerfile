# Build context: services/ (needs file-kb/src/read.js beside this package).
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /srv/file-kb-mcp
COPY file-kb-mcp/package.json file-kb-mcp/package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY file-kb-mcp/src ./src
COPY file-kb/src /srv/file-kb/src
USER node
EXPOSE 18801
HEALTHCHECK --interval=10s --timeout=5s --retries=6 --start-period=10s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.FILE_KB_MCP_PORT||18801)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
