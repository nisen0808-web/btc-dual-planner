FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=8080 BINANCE_LIVE_ENABLED=false BINANCE_DATA_DIR=/data
WORKDIR /app
COPY --chown=node:node execution/ ./execution/
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME ["/data"]
CMD ["node", "execution/binance-cloud-server.mjs"]
