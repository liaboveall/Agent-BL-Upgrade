# syntax=docker/dockerfile:1
# AgentBL web app + API. Fixed W3 runtime artifacts are built from the same source.

FROM node:22-bookworm-slim AS contracts
WORKDIR /contracts
COPY hardhat/package.json hardhat/package-lock.json ./
RUN npm ci --ignore-scripts
COPY hardhat/contracts ./contracts
COPY hardhat/hardhat.config.js ./hardhat.config.js
RUN npm run compile

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Install only production dependencies without package lifecycle hooks.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# The React dashboard (web/) is built with Vite into dist/; only the output reaches the runtime image.
FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY web ./web
COPY public ./public
# The dashboard imports shared subscription rules and the wallet's protocol ABI.
COPY src/core ./src/core
COPY src/chain ./src/chain
COPY src/rights/financePolicy.js ./src/rights/financePolicy.js
RUN npm run build

FROM node:22-alpine
ARG RELEASE_REVISION=UNRECORDED
ARG RELEASE_SOURCE_SHA256=UNRECORDED
LABEL org.opencontainers.image.revision=${RELEASE_REVISION}
LABEL io.agentbl.source-sha256=${RELEASE_SOURCE_SHA256}
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    AGENTBL_RUNTIME_DIR=/app/data/runtime \
    AGENTBL_RELEASE_REVISION=${RELEASE_REVISION}
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY public ./public
COPY --from=web /app/dist ./dist
COPY data ./data
# Shared loopback-port and transaction recovery helpers are runtime dependencies.
COPY scripts/lib ./scripts/lib
# Retain the ABI/runtime inventory needed to read and exit deployed v1 instances.
COPY scripts/config/rights-v1-artifacts.json ./scripts/config/rights-v1-artifacts.json
COPY --from=contracts /contracts/artifacts/contracts ./hardhat/artifacts/contracts

# x402 receipts, cached paid reports, decision logs and Mystery reveals live here:
# mount a volume to keep them across restarts.
RUN mkdir -p /app/data/runtime && chown -R node:node /app/data/runtime
VOLUME ["/app/data/runtime"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/app/server.js"]
