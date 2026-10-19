# File KB API / worker image. Build context: services/file-kb
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /srv/file-kb
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
# Named volume kb-files is initialised from this directory (owner node:node).
RUN mkdir -p /data/kb && chown -R node:node /data/kb
USER node
EXPOSE 18800
HEALTHCHECK --interval=10s --timeout=5s --retries=6 --start-period=15s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.FILE_KB_PORT||18800)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "src/server.js"]
