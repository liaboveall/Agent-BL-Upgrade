# syntax=docker/dockerfile:1
# AgentBL web app + API (src/app/server.js). Contracts and docs are not part of the image.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Lifecycle scripts are not needed at runtime (postinstall only prints a banner).
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# The React dashboard (web/) is built with Vite into dist/; only the output reaches the runtime image.
FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY web ./web
COPY public ./public
# The dashboard imports the API's shared subscription eligibility rules.
COPY src/core ./src/core
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    AGENTBL_RUNTIME_DIR=/app/data/runtime
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY public ./public
COPY --from=web /app/dist ./dist
COPY data ./data
# The server reads the chain registry helper at runtime.
COPY scripts/lib ./scripts/lib

# x402 receipts, cached paid reports, decision logs and Mystery reveals live here:
# mount a volume to keep them across restarts.
RUN mkdir -p /app/data/runtime && chown -R node:node /app/data/runtime
VOLUME ["/app/data/runtime"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/app/server.js"]
