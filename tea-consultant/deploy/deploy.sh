#!/usr/bin/env bash
# Простой скрипт разворачивания/обновления "Чайного города" на сервере.
# Рассчитан на однократный ручной запуск при первом деплое и при последующих обновлениях
# (когда на сервер заливается новый архив с кодом, а .env и storage/ трогать не нужно).
#
# Использование (на сервере, из папки, куда распакован новый архив с кодом):
#   sudo ./deploy/deploy.sh /var/www/tea-consultant
#
# Что делает:
#   1. Копирует код (кроме .env и storage/, logs/ — они не должны затираться)
#   2. Выставляет владельца/права так, чтобы веб-сервер мог писать в storage/ и logs/
#   3. Проверяет синтаксис PHP
#   4. Напоминает перезапустить php-fpm/apache

set -euo pipefail

TARGET_DIR="${1:?Укажите целевую папку, например: sudo ./deploy/deploy.sh /var/www/tea-consultant}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_USER="${WEB_USER:-www-data}"

echo "Источник: $SOURCE_DIR"
echo "Цель:     $TARGET_DIR"

mkdir -p "$TARGET_DIR"

# rsync: --exclude на .env (чтобы не затереть боевой ключ), storage/*.json и logs/*.log
# (чтобы не затереть накопленную историю/логи при обновлении кода).
rsync -av --delete \
    --exclude '.env' \
    --exclude 'storage/conversations/*.json' \
    --exclude 'storage/ratelimit/*.json' \
    --exclude 'logs/*.log' \
    --exclude '.git' \
    "$SOURCE_DIR"/ "$TARGET_DIR"/

# Первый запуск — .env ещё нет, создаём из шаблона и просим заполнить.
if [ ! -f "$TARGET_DIR/.env" ]; then
    cp "$TARGET_DIR/.env.example" "$TARGET_DIR/.env"
    echo ""
    echo "!!! Создан $TARGET_DIR/.env из шаблона — ОБЯЗАТЕЛЬНО впишите туда реальный OPENAI_API_KEY"
    echo "!!! перед тем как открывать сайт публично."
    echo ""
fi

# Права: владелец — тот, от кого работает веб-сервер, чтобы он мог писать в storage/ и logs/.
chown -R "$WEB_USER":"$WEB_USER" "$TARGET_DIR"
find "$TARGET_DIR" -type d -exec chmod 750 "{}" \;
find "$TARGET_DIR" -type f -exec chmod 640 "{}" \;
chmod -R 770 "$TARGET_DIR/storage" "$TARGET_DIR/logs"
chmod 600 "$TARGET_DIR/.env"

# Проверка синтаксиса перед перезапуском сервера — чтобы не выкатить битый код.
echo "Проверка синтаксиса PHP..."
find "$TARGET_DIR" -name '*.php' -print0 | xargs -0 -n1 php -l

# Автоопределение реального сокета/сервиса PHP-FPM — версия PHP отличается от системы
# к системе (на Ubuntu 24.04, например, по умолчанию это PHP 8.3, а не 8.2 из старых примеров),
# поэтому не гадаем, а смотрим, что реально стоит на этом сервере.
DETECTED_SOCK="$(ls /run/php/php*-fpm.sock 2>/dev/null | head -n1 || true)"
DETECTED_SERVICE="$(systemctl list-units --type=service --all 2>/dev/null | grep -oE 'php[0-9]+\.[0-9]+-fpm\.service' | head -n1 || true)"

echo ""
echo "Готово. Осталось:"
echo "  - настроить nginx/apache (см. deploy/nginx.conf.example или deploy/apache-vhost.conf.example)"
if [ -n "$DETECTED_SOCK" ]; then
    echo "    -> обнаруженный сокет PHP-FPM: $DETECTED_SOCK — используйте именно его в fastcgi_pass"
else
    echo "    -> сокет PHP-FPM не найден автоматически: возможно php-fpm ещё не установлен/не запущен (проверьте: ls /run/php/)"
fi
if [ -n "$DETECTED_SERVICE" ]; then
    echo "  - перезапустить PHP-FPM: sudo systemctl restart ${DETECTED_SERVICE%.service}"
else
    echo "  - перезапустить php-fpm (или apache2, если используете mod_php) — сервис не определён автоматически, проверьте: systemctl list-units | grep fpm"
fi
echo "  - проверить: curl -i http://127.0.0.1/  (или ваш домен)"
