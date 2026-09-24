#!/bin/sh
# Runs migrations, then the API. Any migration failure stops the container before it serves traffic.
set -eu
echo "domar: running migrations"
pnpm --filter @domar/db migrate
echo "domar: starting the API on ${API_HOST}:${API_PORT}"
exec pnpm --filter @domar/api start
