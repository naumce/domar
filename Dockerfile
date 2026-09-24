# syntax=docker/dockerfile:1
# Playwright's image so the Chromium used for invoice PDFs matches the pinned playwright-core 1.63.0.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS base
# The image ships an older Node; the workspace requires Node 24.
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# `prepare … --activate` caches pnpm in this shared layer, so the runtime stage never needs the
# network to materialise it on container start.
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY e2e/package.json e2e/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# The web bundle the API will serve, and the production compile gate for the API.
RUN pnpm --filter @domar/web build && pnpm --filter @domar/api build

# The workspace packages ship TypeScript sources, so the runtime keeps the workspace layout and runs
# the API through tsx (see docs/DEPLOY.md). No `pnpm deploy`: it would copy those packages into
# node_modules, where a TypeScript entry point cannot be resolved the way the dev setup resolves it.
FROM base AS runtime
ENV NODE_ENV=production \
    SERVE_WEB=true \
    API_HOST=0.0.0.0 \
    API_PORT=3001 \
    WEB_DIST=/app/apps/web/dist \
    PDF_BROWSER_CHANNEL=chromium
COPY --from=build /app /app
RUN chmod +x /app/scripts/docker-entrypoint.sh
EXPOSE 3001
CMD ["/app/scripts/docker-entrypoint.sh"]
