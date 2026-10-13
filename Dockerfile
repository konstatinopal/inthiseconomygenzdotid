# One image, two roles: the sync server (also serves the web app) and the
# optional HTTP API. Pick the role with the container command.

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci && npm run build -w @envelope/web && npm prune --omit=dev

FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    ENVELOPE_DATA_DIR=/data \
    ENVELOPE_PORT=5006 \
    ENVELOPE_WEB_ROOT=/app/packages/web/dist
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 5006 5007
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||process.env.ENVELOPE_PORT)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "packages/sync-server/src/index.ts"]
