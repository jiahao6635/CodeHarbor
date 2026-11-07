FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev && mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production CODEHARBOR_BIND=0.0.0.0 CODEHARBOR_DATA_DIR=/data PORT=8080
EXPOSE 8080
CMD ["node", "dist/main.js"]
