# ── WhatsappErdBot ──────────────────────────────────────────────
# Production Dockerfile — Node 20 Alpine
# ─────────────────────────────────────────────────────────────────

FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache dumb-init

COPY --from=builder /app/node_modules ./node_modules
COPY package.json .
COPY src/ ./src/
COPY config/ ./config/ 2>/dev/null || true

RUN mkdir -p /app/data/database /app/data/auth_info /app/logs

EXPOSE 3099

ENV NODE_ENV=production
ENV LOG_LEVEL=info

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3099/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
