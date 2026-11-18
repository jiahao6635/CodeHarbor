FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl patch \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# The source release is verified before it is unpacked or built.
RUN curl -fsSL https://codeload.github.com/colbymchenry/codegraph/tar.gz/refs/tags/v1.6.2 -o /tmp/codegraph.tar.gz \
    && echo '10bbcceaba46be5d37324e94427684a6d33dcbb592c35fbe4d387c2a14a36ff9  /tmp/codegraph.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/codegraph.tar.gz --strip-components=1 -C /src
COPY readonly-mcp.patch /tmp/readonly-mcp.patch
RUN patch --fuzz=0 -p1 < /tmp/readonly-mcp.patch \
    && npm ci --ignore-scripts --audit=false \
    && ./node_modules/.bin/tsc \
    && npm run copy-assets

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /readonly-codegraph
COPY runtime-package.json ./package.json
COPY runtime-package-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts --audit=false \
    && mkdir -p /workspace/repo && chown -R node:node /workspace
COPY --from=build /src/dist ./dist
COPY LICENSE ./LICENSE
COPY seal-index.cjs ./seal-index.cjs
USER node
ENV HOME=/tmp CODEGRAPH_MCP_READ_ONLY=1 CODEGRAPH_NO_DAEMON=1 CODEGRAPH_NO_WATCH=1 \
    CODEGRAPH_NO_DOWNLOAD=1 DO_NOT_TRACK=1 \
    CODEGRAPH_MCP_TOOLS=search,callers,callees,impact,node,explore,files
WORKDIR /workspace/repo
ENTRYPOINT ["node", "/readonly-codegraph/dist/bin/codegraph.js"]
CMD ["serve", "--mcp", "--path", "/workspace/repo"]
