# =============================================================================
# FixForge Web Frontend Dockerfile
# Multi-stage build: Vite bundling -> Lightweight Nginx production serving
# =============================================================================

FROM node:20-alpine AS builder

WORKDIR /app

# Copy root monorepo manifests for workspace resolution
COPY package.json package-lock.json ./
COPY artifacts/fixforge/package.json ./artifacts/fixforge/
COPY lib/api-client-react/package.json ./lib/api-client-react/
COPY lib/api-zod/package.json ./lib/api-zod/
COPY lib/api-spec/package.json ./lib/api-spec/
COPY lib/db/package.json ./lib/db/

# Reproducible installation of workspace dependencies
RUN npm ci

# Copy TypeScript configuration and source libraries required for frontend compilation
COPY tsconfig.base.json tsconfig.json ./
COPY lib/ ./lib/
COPY artifacts/fixforge/ ./artifacts/fixforge/

ENV NODE_OPTIONS="--max-old-space-size=4096"

# Build client production bundle (outputs to artifacts/fixforge/dist/public)
RUN npm --workspace=@workspace/fixforge run build

# =============================================================================
# Production Runtime Stage (Lightweight Nginx)
# =============================================================================
FROM nginx:alpine AS runner

# Remove default nginx configuration
RUN rm -f /etc/nginx/conf.d/default.conf

# Copy reverse proxy & SPA Nginx configuration
COPY artifacts/fixforge/nginx.conf /etc/nginx/conf.d/fixforge.conf

# Copy compiled static assets from builder stage (no source files or dev tools included)
COPY --from=builder /app/artifacts/fixforge/dist/public /usr/share/nginx/html

EXPOSE 80

# Healthcheck against frontend root
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
