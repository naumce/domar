#!/usr/bin/env bash
# pg_dump of the production database into ./backups, keeping the newest 14 dumps.
# Run from the repo root on the server, e.g. from cron: 15 2 * * * cd /srv/domar && ./scripts/backup.sh
set -euo pipefail

cd "$(dirname "$0")/.."
# The same .env compose reads, so POSTGRES_USER/POSTGRES_DB/BACKUP_DIR mean the same here and there.
if [ -f ./.env ]; then set -a; . ./.env; set +a; fi

DIR="${BACKUP_DIR:-./backups}"
USER_NAME="${POSTGRES_USER:-domar}"
DB_NAME="${POSTGRES_DB:-domar}"
MIN_BYTES=1024

mkdir -p "$DIR"
FILE="$DIR/domar-$(date +%Y-%m-%d-%H%M).sql.gz"
TMP="$FILE.part"
trap 'rm -f "$TMP"' EXIT

# pipefail above makes a failing pg_dump fail the script even though gzip succeeds.
docker compose -f docker-compose.prod.yml exec -T db pg_dump -U "$USER_NAME" "$DB_NAME" | gzip -9 > "$TMP"

SIZE=$(wc -c < "$TMP" | tr -d " ")
if [ "$SIZE" -lt "$MIN_BYTES" ]; then
  echo "backup aborted: $TMP is only $SIZE bytes (< $MIN_BYTES), the dump is not usable" >&2
  exit 1
fi

# Only a verified dump becomes a backup, and only then is anything rotated away.
mv "$TMP" "$FILE"
echo "wrote $FILE ($SIZE bytes)"
ls -1t "$DIR"/domar-*.sql.gz | tail -n +15 | xargs -r rm --
