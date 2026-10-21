#!/usr/bin/env bash
# Очистка старых служебных файлов "Чайного города".
# Приложение само НЕ удаляет старые файлы истории/rate-limit — они накапливаются
# в storage/ бесконечно. На проде стоит чистить их периодически через cron.
#
# Использование:
#   chmod +x deploy/cleanup.sh
#   ./deploy/cleanup.sh /var/www/tea-consultant
#
# Пример строки в crontab (запуск раз в сутки, в 4:15 ночи):
#   15 4 * * * /var/www/tea-consultant/deploy/cleanup.sh /var/www/tea-consultant >> /var/log/tea-consultant-cleanup.log 2>&1

set -euo pipefail

PROJECT_DIR="${1:?Укажите путь к проекту, например: ./cleanup.sh /var/www/tea-consultant}"

# Файлы rate-limit — служебные, живут максимум RATE_LIMIT_WINDOW_SECONDS (обычно 5 минут).
# Через час они точно не нужны. Чистим то, что старше 1 дня — с запасом.
find "$PROJECT_DIR/storage/ratelimit" -type f -name '*.json' -mtime +1 -delete 2>/dev/null || true

# Файлы истории диалогов — храним дольше, но не вечно. Ниже пример: 90 дней.
# Подстройте срок под свои требования к хранению переписки пользователей.
find "$PROJECT_DIR/storage/conversations" -type f -name '*.json' -mtime +90 -delete 2>/dev/null || true

echo "[$(date -Iseconds)] cleanup done: ratelimit >1d, conversations >90d removed"
