FROM node:20-bookworm-slim AS deps
WORKDIR /src
COPY web/package.json web/package-lock.json ./web/
COPY simple-mind-map/package.json simple-mind-map/package-lock.json ./simple-mind-map/
RUN cd web && npm ci
RUN cd simple-mind-map && npm ci

FROM deps AS build
COPY web ./web
COPY simple-mind-map ./simple-mind-map
RUN rm -rf /src/web/node_modules/simple-mind-map \
  && cp -R /src/simple-mind-map /src/web/node_modules/simple-mind-map \
  && rm -rf /src/web/node_modules/simple-mind-map/node_modules
WORKDIR /src/web
ENV NODE_ENV=production
ENV PUBLIC_PATH=/
RUN npx vue-cli-service build --dest /out/web

FROM node:20-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends nginx ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /usr/share/nginx/html /var/log/nginx /var/cache/nginx /tmp

WORKDIR /app
COPY web/scripts ./web/scripts
COPY web/package.json ./web/package.json
COPY simple-mind-map ./simple-mind-map
COPY --from=deps /src/web/node_modules ./web/node_modules
COPY --from=deps /src/simple-mind-map/node_modules ./simple-mind-map/node_modules
COPY --from=build /out/web /usr/share/nginx/html
COPY docker/runtime-config.js /usr/share/nginx/html/runtime-config.js
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/start.sh /app/start.sh

ENV HOST=127.0.0.1 \
    PORT=1234 \
    MCP_HOST=127.0.0.1 \
    MCP_PORT=3847 \
    MIND_MAP_API=http://127.0.0.1:1234 \
    GATEWAY=1 \
    NODE_ENV=production

RUN sed -i 's/\r$//' /app/start.sh \
  && chmod +x /app/start.sh \
  && chmod -R a+rX /usr/share/nginx/html

EXPOSE 80
CMD ["/app/start.sh"]
