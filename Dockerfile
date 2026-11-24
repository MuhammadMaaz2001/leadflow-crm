# syntax=docker/dockerfile:1
# One multi-stage Dockerfile for all LeadFlow processes. Build a target with:
#   docker build --target api     -t leadflow-api .
#   docker build --target worker  -t leadflow-worker .
#   docker build --target migrate -t leadflow-migrate .
#   docker build --target web --build-arg API_URL=https://api.example.com -t leadflow-web .
# NOTE: these files were written but NOT built in the environment where the project was developed (no Docker daemon was available).
# Build and smoke-test them in CI before relying on them.

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 CI=true
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/database/package.json packages/database/
COPY packages/shared/package.json packages/shared/
COPY packages/database/prisma packages/database/prisma
RUN npm ci
COPY . .
# The web app proxies /api/* to the API; the target is baked into the Next.js routes manifest at build time.
ARG API_URL=http://localhost:4000
ENV API_URL=${API_URL}
RUN npm run build

# ── one-off job: applies migrations and sets the runtime role passwords (needs DATABASE_URL, APP_DB_PASSWORD, PLATFORM_DB_PASSWORD) ──
FROM build AS migrate
CMD ["npm", "run", "db:migrate"]

# ── API and worker share one image; the command differs ──
FROM build AS prune
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production SERVICE_NAME=leadflow-api
COPY --from=prune /app /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/server.js"]

FROM api AS worker
ENV SERVICE_NAME=leadflow-worker WORKER_HEALTH_PORT=4001
EXPOSE 4001
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:4001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/worker.js"]

FROM node:22-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
COPY --from=prune /app /app
USER node
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@leadflow/web"]
