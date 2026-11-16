FROM node:22-bookworm-slim AS console
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build && npm prune --omit=dev && mkdir -p /data && chown node:node /data
COPY --from=console /web/dist ./web/dist
USER node
ENV NODE_ENV=production CODEHARBOR_BIND=0.0.0.0 CODEHARBOR_DATA_DIR=/data PORT=8080
EXPOSE 8080
CMD ["node", "dist/main.js"]
