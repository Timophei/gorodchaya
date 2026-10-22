#!/usr/bin/env bash
# Снимок данных магазина: каталог (цены, остатки, тексты), заказы, пользователи, посетители.
#   bash /opt/gorodchaya/snapshot.sh            — снимок с меткой «manual»
#   bash /opt/gorodchaya/snapshot.sh before-test — со своей меткой
# Вернуться к снимку: bash /opt/gorodchaya/rollback.sh
set -euo pipefail
BE=${BE:-/var/www/chainy-gorod-backend}
DST=${SNAP_DIR:-/var/backups/chaygorod/snapshots}
LABEL="$(echo "${1:-manual}" | tr -c 'A-Za-z0-9_-' '-' | sed 's/-*$//')"
mkdir -p "$DST"; chmod 700 "$DST"
FILE="$DST/$(date +%F-%H%M%S)-$LABEL.tar.gz"
tar -czf "$FILE" -C "$BE" data
echo "Снимок сохранён: $FILE"
# Храним последние 30 снимков.
ls -1t "$DST"/*.tar.gz 2>/dev/null | tail -n +31 | xargs -r rm -f
