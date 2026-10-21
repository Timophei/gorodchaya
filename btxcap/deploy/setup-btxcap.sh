#!/usr/bin/env bash
# Разворачивает CRM.Капитан на этом сервере рядом с существующими сайтами
# (tea-consultant, chainy-gorod): свой каталог в /var/www, свой nginx server block,
# общий PHP-FPM (php8.3-fpm.sock), HTTPS через certbot. Без Docker.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Запустите от root (sudo -i, или как обычно заходите на сервер)." >&2
  exit 1
fi

SITE_DIR="/var/www/btxcap"
NGINX_CONF="/etc/nginx/sites-available/btxcap.conf"

if [ ! -d "$SITE_DIR/public" ]; then
  echo "Не найден $SITE_DIR/public — сначала распакуйте туда содержимое архива (см. README-DEPLOY.md)." >&2
  exit 1
fi

echo "== Права доступа =="
chown -R www-data:www-data "$SITE_DIR"
find "$SITE_DIR" -type d -exec chmod 750 {} \;
find "$SITE_DIR" -type f -exec chmod 640 {} \;

if [ ! -f "$SITE_DIR/config.php" ]; then
  cp "$SITE_DIR/config.example.php" "$SITE_DIR/config.php"
  chown www-data:www-data "$SITE_DIR/config.php"
  chmod 640 "$SITE_DIR/config.php"
  echo ">>> Создан $SITE_DIR/config.php — заполните recipient / from / webhook перед проверкой формы."
fi

echo "== nginx конфиг =="
cat > "$NGINX_CONF" <<'NGINX_EOF'
server {
    server_name btxcap.ru www.btxcap.ru btxcap.online www.btxcap.online;

    root /var/www/btxcap/public;
    index index.html;

    access_log /var/log/nginx/btxcap.access.log;
    error_log  /var/log/nginx/btxcap.error.log;

    location = /submit.php {
        try_files $uri =404;
        fastcgi_pass unix:/run/php/php8.3-fpm.sock;
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        include fastcgi_params;
        fastcgi_read_timeout 25s;
    }

    location ~ \.php$ {
        deny all;
        return 404;
    }

    location ~ /\.(?!well-known) {
        deny all;
        return 404;
    }

    client_max_body_size 1m;

    location / {
        try_files $uri $uri/ =404;
    }

    listen 80;
    listen [::]:80;
}
NGINX_EOF

ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/btxcap.conf

nginx -t
systemctl reload nginx

echo
echo "== Готово =="
echo "1) Проверьте, что A-записи btxcap.ru и btxcap.online указывают на этот сервер."
echo "2) Получите сертификат (добавьте -d www.btxcap.ru -d www.btxcap.online, если эти поддомены тоже прописаны в DNS):"
echo "   certbot --nginx -d btxcap.ru -d btxcap.online"
echo "3) Заполните $SITE_DIR/config.php и отправьте тестовую заявку с сайта."
