FROM node:20-bookworm-slim
WORKDIR /app/integrations/wiki-graph
COPY integrations/knowledge-mcp/package.json integrations/knowledge-mcp/package-lock.json ./
RUN npm ci --omit=dev
COPY integrations/wiki-graph/server.cjs integrations/wiki-graph/index.html ./
COPY simple-mind-map/bin/wikiCompiler/access.js /app/simple-mind-map/bin/wikiCompiler/access.js
ENV WIKI_DIR=/wiki PORT=3848
EXPOSE 3848
CMD ["node", "server.cjs"]
