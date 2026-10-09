# Phase 4 hardened image ? non-root at runtime via entrypoint+gosu
FROM node:22-bookworm-slim

RUN apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o APT::Update::Error-Mode=any update \
  && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 install -y --no-install-recommends gosu ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data/audit /data/openwiki/jobs /data/openwiki/rooms \
  && chown -R node:node /data

WORKDIR /app/integrations/knowledge-mcp

COPY integrations/knowledge-mcp/package.json integrations/knowledge-mcp/package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node integrations/knowledge-mcp/src ./src
COPY simple-mind-map/bin/wikiCompiler/access.js /app/simple-mind-map/bin/wikiCompiler/access.js
COPY integrations/knowledge-mcp/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Guard against CRLF checkouts on Windows hosts: a trailing \r in the shebang
# makes the container die with "exec ... no such file or directory".
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
  && chmod 755 /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV KNOWLEDGE_MCP_PORT=18792
EXPOSE 18792

# Start as root only to chown mounts; entrypoint drops to node
USER root
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
