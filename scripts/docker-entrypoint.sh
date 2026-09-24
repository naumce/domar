#!/bin/sh
# Runs migrations, then replaces this shell with node itself, so the API process is PID 1 and gets
# SIGTERM straight from `docker stop` instead of relying on pnpm to forward it.
# Any migration failure stops the container before it serves traffic.
set -eu
echo "domar: running migrations"
pnpm --filter @domar/db migrate
echo "domar: starting the API on ${API_HOST}:${API_PORT}"
cd /app/apps/api
exec node --import tsx src/index.ts
