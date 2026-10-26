# =============================================================================
# FixForge Node.js API Server Dockerfile
# Multi-stage production build with non-root security execution (Alpine-based)
# =============================================================================

FROM node:20-alpine AS builder

WORKDIR /app

# Install OpenSSL & libc6-compat required by Prisma query engine on Alpine (musl)
RUN apk add --no-cache openssl libc6-compat

# Copy root monorepo workspace configuration & package manifests
COPY package.json package-lock.json ./
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY lib/api-zod/package.json ./lib/api-zod/
COPY lib/api-spec/package.json ./lib/api-spec/
COPY lib/db/package.json ./lib/db/

# Reproducible workspace dependency installation using monorepo lockfile
RUN npm ci

# Copy TypeScript configuration and required workspace source packages
COPY tsconfig.base.json tsconfig.json ./
COPY lib/ ./lib/
COPY artifacts/api-server/ ./artifacts/api-server/

# Generate Prisma client for SQLite/PostgreSQL runtime
RUN npm --workspace=@workspace/db run db:generate

# =============================================================================
# Production Runtime Stage
# =============================================================================
FROM node:20-alpine AS runner

WORKDIR /app

# Install OpenSSL runtime dependency for Prisma and curl for health check
RUN apk add --no-cache openssl libc6-compat curl

# Create persistent data volume directory owned by unprivileged node user (UID 1000)
RUN mkdir -p /data && chown -R node:node /data

# Copy built workspace tree from builder stage with proper ownership
COPY --chown=node:node --from=builder /app /app

# Run application under unprivileged non-root node user
USER node

ENV NODE_ENV=production \
    PORT=5000 \
    DATABASE_URL=file:/data/fixforge.db

EXPOSE 5000

# Verified healthcheck against express /api/healthz endpoint
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:5000/api/healthz || exit 1

CMD ["node", "artifacts/api-server/src/index.js"]
