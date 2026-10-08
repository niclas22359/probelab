# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# ExampleLab — container build (Beyondles Lab frame, Playground server).
#
# Three targets:
#   builder   — builds the standalone bundle (`next build`, output: "standalone")
#   toolchain — Prisma CLI + schema for `migrate deploy` inside the Compose
#               network (migrations run as their own observable step in the
#               deploy script, NOT at app start)
#   runtime   — minimal runtime image: standalone server + static files
#
# No `prisma db seed` anywhere in the deploy path.
# ---------------------------------------------------------------------------

# Base images pinned by digest (lab learnings, rule 10): an unpinned tag once
# changed upstream and silently broke deletes. Renew the digest on purpose:
#   docker buildx imagetools inspect node:22-alpine
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS deps
WORKDIR /app
# Build-time dummy: prisma.config.ts wants the variable already during
# `prisma generate` (postinstall). The real value arrives at RUNTIME from
# Compose — this one connects nowhere.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci

# --- Build ------------------------------------------------------------------
FROM deps AS builder
COPY . .
# .dockerignore keeps .env/.env.local out of the context — secrets reach the
# container only at runtime through Compose.
RUN npm run build

# --- Toolchain for migrations ------------------------------------------------
FROM deps AS toolchain
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
# Scheduled jobs (retention, heartbeat) run here, from the host's cron:
#   docker compose ... run --rm --no-deps toolchain npm run job -- retention
COPY src ./src
COPY scripts ./scripts
COPY messages ./messages
CMD ["sh", "-c", "echo 'toolchain: docker compose run --rm --no-deps toolchain npx prisma migrate deploy'"]

# --- Runtime ----------------------------------------------------------------
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# Standalone bundle: server.js + the node_modules it really needs.
COPY --from=builder --chown=node:node /app/.next/standalone ./
# Static files are NOT part of the standalone bundle.
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
# Translations: next-intl loads them at runtime.
COPY --from=builder --chown=node:node /app/messages ./messages
USER node
EXPOSE 3000
CMD ["node", "server.js"]
