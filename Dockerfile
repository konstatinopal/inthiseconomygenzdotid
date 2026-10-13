# One image runs the sync server and serves the web app.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build -w @envelope/web

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production ENVELOPE_DATA_DIR=/data ENVELOPE_PORT=5006
COPY --from=build /app /app
VOLUME /data
EXPOSE 5006
CMD ["npx", "tsx", "packages/sync-server/src/index.ts"]
