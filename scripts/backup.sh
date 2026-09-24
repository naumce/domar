#!/bin/sh
# pg_dump of the production database into ./backups, keeping the newest 14 files.
# Run from the repo root on the server, e.g. from cron: 15 2 * * * cd /srv/domar && ./scripts/backup.sh
set -eu
DIR="${BACKUP_DIR:-./backups}"
USER_NAME="${POSTGRES_USER:-domar}"
DB_NAME="${POSTGRES_DB:-domar}"
mkdir -p "$DIR"
FILE="$DIR/domar-$(date +%Y-%m-%d-%H%M).sql.gz"
docker compose -f docker-compose.prod.yml exec -T db pg_dump -U "$USER_NAME" "$DB_NAME" | gzip -9 > "$FILE"
echo "wrote $FILE"
ls -1t "$DIR"/domar-*.sql.gz | tail -n +15 | xargs -r rm --
