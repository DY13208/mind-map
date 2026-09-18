# Phase 4 hardened image ? non-root at runtime via entrypoint+gosu
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data/audit /data/openwiki/jobs /data/openwiki/rooms \
  && chown -R node:node /data

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV KNOWLEDGE_MCP_PORT=18792
EXPOSE 18792

# Start as root only to chown mounts; entrypoint drops to node
USER root
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
