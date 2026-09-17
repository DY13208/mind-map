FROM node:22-bookworm-slim
ARG OPENWIKI_VERSION=0.5.2
# 同根目录 Dockerfile：构建容器不继承宿主机代理，deb.debian.org 在国内会被掐断，
# 这里换镜像源 + 失败重试做兜底（真正生效的是 compose 透传的 HTTP_PROXY）。
# bookworm 是 deb822 格式，源文件在 /etc/apt/sources.list.d/debian.sources。
ARG DEBIAN_MIRROR=mirrors.aliyun.com
RUN set -eux; \
    for f in /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list; do \
      if [ -f "$f" ]; then sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g" "$f"; fi; \
    done; \
    apt-get update -o Acquire::Retries=3; \
    apt-get install -y --no-install-recommends python3 make g++ git ca-certificates; \
    npm install --global --omit=optional openwiki@${OPENWIKI_VERSION}; \
    apt-get purge -y --auto-remove python3 make g++; \
    rm -rf /var/lib/apt/lists/* /root/.npm
WORKDIR /data/openwiki
COPY entrypoint.sh proxy.cjs setup.cjs probe.cjs canonical-mcp.cjs /runtime/
RUN sed -i 's/\r$//' /runtime/entrypoint.sh && chmod +x /runtime/entrypoint.sh
ENV OPENWIKI_CONFIG_DIR=/data/openwiki DO_NOT_TRACK=1
ENTRYPOINT ["/runtime/entrypoint.sh"]
CMD ["integrations", "list"]
