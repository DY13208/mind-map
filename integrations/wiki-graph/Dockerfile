FROM node:20-bookworm-slim
WORKDIR /app
COPY server.cjs index.html ./
ENV WIKI_DIR=/wiki PORT=3848
EXPOSE 3848
CMD ["node", "server.cjs"]
