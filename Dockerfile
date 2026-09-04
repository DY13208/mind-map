FROM node:20-bookworm-slim AS deps
WORKDIR /src

# Playwright postinstall 会下浏览器；y-websocket 可选依赖 leveldown 会在
# slim 镜像里编译原生模块，两者都会让 docker build 长时间停在 npm ci。
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false

COPY web/package.json web/package-lock.json ./web/
COPY simple-mind-map/package.json simple-mind-map/package-lock.json ./simple-mind-map/
# vue-cli 在 devDependencies，前端构建必须装上。
RUN cd web && npm ci --omit=optional
# 协作服务不需要测试工具，也不需要 y-leveldb/leveldown。
RUN cd simple-mind-map && npm ci --omit=dev --omit=optional

FROM deps AS build
COPY web ./web
COPY simple-mind-map ./simple-mind-map
RUN rm -rf /src/web/node_modules/simple-mind-map \
  && cp -R /src/simple-mind-map /src/web/node_modules/simple-mind-map \
  && rm -rf /src/web/node_modules/simple-mind-map/node_modules
WORKDIR /src/web
ENV NODE_ENV=production
ENV PUBLIC_PATH=/
ENV NODE_OPTIONS=--openssl-legacy-provider
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
