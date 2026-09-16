FROM node:22-bookworm-slim
ARG OPENWIKI_VERSION=0.5.2
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
    && npm install --global --omit=optional openwiki@${OPENWIKI_VERSION} \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/* /root/.npm
WORKDIR /data/openwiki
COPY entrypoint.sh proxy.cjs setup.cjs probe.cjs canonical-mcp.cjs /runtime/
RUN sed -i 's/\r$//' /runtime/entrypoint.sh && chmod +x /runtime/entrypoint.sh
ENV OPENWIKI_CONFIG_DIR=/data/openwiki DO_NOT_TRACK=1
ENTRYPOINT ["/runtime/entrypoint.sh"]
CMD ["integrations", "list"]
