#!/usr/bin/env bash
# Откат данных магазина к снимку (см. snapshot.sh).
#   bash /opt/gorodchaya/rollback.sh          — список снимков
#   bash /opt/gorodchaya/rollback.sh last     — к последнему
#   bash /opt/gorodchaya/rollback.sh <файл>   — к конкретному
# Возвращает каталог, остатки, заказы и пользователей целиком на момент снимка:
# всё, что случилось после (в том числе настоящие заказы), пропадёт. Текущее
# состояние перед откатом само сохраняется снимком «before-rollback» —
# откат можно отменить, откатившись к нему.
# Убрать только тестовые заказы без отката всего: админка → Заказы → «Удалить все тестовые».
set -euo pipefail
BE=${BE:-/var/www/chainy-gorod-backend}
DST=${SNAP_DIR:-/var/backups/chaygorod/snapshots}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ $# -eq 0 ]; then
  echo "Снимки (новые сверху):"; ls -1t "$DST"/*.tar.gz 2>/dev/null | head -20 || echo "  нет снимков"
  echo; echo "Откатить: bash $0 last   или   bash $0 <файл>"; exit 0
fi
SNAP="$1"
[ "$SNAP" = last ] && SNAP="$(ls -1t "$DST"/*.tar.gz | grep -v before-rollback | head -1)"
[ -f "$SNAP" ] || SNAP="$DST/$SNAP"
[ -f "$SNAP" ] || { echo "Нет такого снимка: $1" >&2; exit 1; }
echo "Откат к: $SNAP"
read -r -p "Данные после этого снимка пропадут. Продолжить? [y/N] " ok
[ "$ok" = y ] || [ "$ok" = Y ] || { echo "Отменено."; exit 1; }
bash "$HERE/snapshot.sh" before-rollback
systemctl stop chainy-gorod-backend
TMP="$(mktemp -d)"; tar -xzf "$SNAP" -C "$TMP"
rm -rf "$BE/data.rollback-old"; mv "$BE/data" "$BE/data.rollback-old"; mv "$TMP/data" "$BE/data"; rm -rf "$TMP"
chown -R www-data:www-data "$BE/data"
systemctl start chainy-gorod-backend
for i in $(seq 1 15); do curl -fsS http://127.0.0.1:4000/api/health >/dev/null 2>&1 && break; sleep 1; done
KEY="$(grep -E '^API_KEY=' /etc/chainy-gorod-backend.env | cut -d= -f2-)"
curl -s -X POST -H "x-api-key: $KEY" http://127.0.0.1:4000/api/admin/catalog-sync >/dev/null || true
rm -rf "$BE/data.rollback-old"
echo "Готово: данные как в $(basename "$SNAP"). Страницы чаёв перепекаются."
