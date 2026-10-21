#!/usr/bin/env bash
# Восстановление сервера «Чайный город» + CRM.Капитан с нуля (Ubuntu 24.04).
# Запуск на сервере от root из распакованной папки:  bash install.sh
# Повторный запуск безопасен: секреты, заказы, диалоги и логи не затираются.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Запустите от root." >&2; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRED=/root/chaygorod-credentials.txt
step() { echo; echo "=== $* ==="; }

step "1/9 Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx php-fpm php-curl php-mbstring nodejs npm unzip rsync ufw \
  certbot python3-certbot-nginx apache2-utils openssl curl
PHP_SOCK="$(ls /run/php/php*-fpm.sock 2>/dev/null | grep -v 'php-fpm.sock$' | sort -V | tail -1 || true)"
[ -n "$PHP_SOCK" ] || PHP_SOCK=/run/php/php8.3-fpm.sock
PHP_VER="$(basename "$PHP_SOCK" | sed -E 's/^php([0-9.]+)-fpm\.sock$/\1/')"
echo "PHP-FPM: $PHP_SOCK (версия $PHP_VER), Node: $(node -v)"

step "2/9 Секреты"
BE_ENV=/etc/chainy-gorod-backend.env
if [ ! -f "$BE_ENV" ]; then
  umask 077
  cat > "$BE_ENV" <<ENVEOF
PORT=4000
API_KEY=$(openssl rand -hex 24)
SESSION_SECRET=$(openssl rand -hex 32)
# Токен бота @TeaGorodBot от @BotFather — нужен для входа через Telegram в личном кабинете.
TELEGRAM_BOT_TOKEN=
ENVEOF
  umask 022
  echo "Создан $BE_ENV (новые API_KEY и SESSION_SECRET)."
else
  echo "$BE_ENV уже есть — не трогаю."
fi
chmod 600 "$BE_ENV"
API_KEY="$(grep -E '^API_KEY=' "$BE_ENV" | cut -d= -f2-)"

step "3/9 Консультант (PHP) -> /var/www/tea-consultant"
TC=/var/www/tea-consultant
mkdir -p "$TC"
rsync -a --exclude '.env' --exclude 'storage/conversations/*.json' \
  --exclude 'storage/ratelimit/*.json' --exclude 'logs/*.log' "$HERE/tea-consultant/" "$TC/"
[ -f "$TC/.env" ] || cp "$HERE/tea-consultant/.env" "$TC/.env"
if grep -q '^CHAYGOROD_API_KEY=' "$TC/.env"; then
  sed -i "s|^CHAYGOROD_API_KEY=.*|CHAYGOROD_API_KEY=$API_KEY|" "$TC/.env"
else
  printf '\n# Ключ бэкенда витрины — нужен вкладке «Заказы» в /admin/\nCHAYGOROD_API_KEY=%s\n' "$API_KEY" >> "$TC/.env"
fi
mkdir -p "$TC/storage/conversations" "$TC/storage/ratelimit" "$TC/logs"
chown -R www-data:www-data "$TC"
find "$TC" -type d -exec chmod 750 {} \;
find "$TC" -type f -exec chmod 640 {} \;
chmod -R 770 "$TC/storage" "$TC/logs"
chmod 600 "$TC/.env"
chmod 750 "$TC/deploy/"*.sh
find "$TC" -name '*.php' -print0 | xargs -0 -n1 php -l >/dev/null
cp "$TC/deploy/php-production.ini.example" "/etc/php/$PHP_VER/fpm/conf.d/99-tea-consultant.ini"
touch /var/log/php-tea-consultant-error.log && chown www-data:www-data /var/log/php-tea-consultant-error.log
if ! "php-fpm$PHP_VER" -t 2>/dev/null; then
  rm -f "/etc/php/$PHP_VER/fpm/conf.d/99-tea-consultant.ini"
  echo "ВНИМАНИЕ: php-production.ini не принят php-fpm, пропущен."
fi
install -m 644 "$HERE/deploy/php-admin-upload.ini" "/etc/php/$PHP_VER/fpm/conf.d/99z-chaygorod-admin-upload.ini"
systemctl restart "php$PHP_VER-fpm"
cp "$TC/deploy/logrotate-tea-consultant.example" /etc/logrotate.d/tea-consultant
echo "15 4 * * * www-data $TC/deploy/cleanup.sh $TC >> /var/log/tea-consultant-cleanup.log 2>&1" > /etc/cron.d/tea-consultant-cleanup
touch /var/log/tea-consultant-cleanup.log && chown www-data:www-data /var/log/tea-consultant-cleanup.log

step "4/9 Витрина (статика) -> /var/www/chainy-gorod-site"
SITE=/var/www/chainy-gorod-site
mkdir -p "$SITE"
rsync -a "$HERE/site/" "$SITE/"
chown -R www-data:www-data "$SITE"
find "$SITE" -type d -exec chmod 755 {} \;
find "$SITE" -type f -exec chmod 644 {} \;

step "5/9 Бэкенд магазина (Node) -> /var/www/chainy-gorod-backend"
BE=/var/www/chainy-gorod-backend
mkdir -p "$BE/data"
rsync -a --exclude 'data/' --exclude 'node_modules/' "$HERE/backend/" "$BE/"
(cd "$BE" && npm install --omit=dev --no-audit --no-fund)
chown -R www-data:www-data "$BE"
chmod 750 "$BE/data"
(cd "$BE" && runuser -u www-data -- node seed.js && runuser -u www-data -- env SITE_DIR="$SITE" node restore-images.js)
cat > /etc/systemd/system/chainy-gorod-backend.service <<UNITEOF
[Unit]
Description=Чайный город — API магазина (Node/Express)
After=network.target

[Service]
User=www-data
Group=www-data
WorkingDirectory=$BE
EnvironmentFile=$BE_ENV
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNITEOF
systemctl daemon-reload
systemctl enable chainy-gorod-backend >/dev/null
systemctl restart chainy-gorod-backend
for i in $(seq 1 20); do curl -fsS http://127.0.0.1:4000/api/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:4000/api/health >/dev/null || { journalctl -u chainy-gorod-backend -n 30 --no-pager; echo "Бэкенд не поднялся." >&2; exit 1; }

step "6/9 Страницы чаёв (генератор) -> /opt/chainy-gorod-generator"
GEN=/opt/chainy-gorod-generator
mkdir -p "$GEN"
rsync -a "$HERE/generator/" "$GEN/"
chmod -R a+rX "$GEN"
cat > /usr/local/bin/chaygorod-generate <<GENEOF
#!/usr/bin/env bash
# Перепечь tea-<id>.html и sitemap.xml из текущего каталога. Запускать после правок чаёв.
exec runuser -u www-data -- env OUT_DIR=$SITE SITE_ORIGIN=https://gorodchaya.ru node $GEN/tools/generate-tea-pages.mjs
GENEOF
chmod 755 /usr/local/bin/chaygorod-generate
/usr/local/bin/chaygorod-generate
echo "17 * * * * root /usr/local/bin/chaygorod-generate >> /var/log/chaygorod-generate.log 2>&1" > /etc/cron.d/chaygorod-generate

step "7/9 CRM.Капитан -> /var/www/btxcap"
BX=/var/www/btxcap
mkdir -p "$BX"
rsync -a --exclude 'config.php' --exclude 'private-state/' "$HERE/btxcap/" "$BX/"
[ -f "$BX/config.php" ] || cp "$BX/config.example.php" "$BX/config.php"
mkdir -p "$BX/private-state"
chown -R www-data:www-data "$BX"
find "$BX" -type d -exec chmod 750 {} \;
find "$BX" -type f -exec chmod 640 {} \;

step "8/9 nginx"
HT=/etc/nginx/.htpasswd-tea-admin
if [ ! -f "$HT" ]; then
  ADMIN_PASS="$(openssl rand -base64 15 | tr -d '/+=')"
  htpasswd -bc "$HT" admin "$ADMIN_PASS" >/dev/null 2>&1
  chown root:www-data "$HT"; chmod 640 "$HT"
  umask 077
  { echo "Админка https://gorodchaya.ru/admin/"; echo "  логин:  admin"; echo "  пароль: $ADMIN_PASS"; echo; } >> "$CRED"
  umask 022
fi
cat > /etc/nginx/sites-available/gorodchaya.conf <<NGXEOF
# Чайный город: витрина (статика) + API магазина (Node, :4000) + консультант и админка (PHP).
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name gorodchaya.ru www.gorodchaya.ru gorodchaya.online www.gorodchaya.online;

    root $SITE;
    include snippets/chaygorod-tea-routes.conf;
    index index.html;

    access_log /var/log/nginx/gorodchaya.access.log;
    error_log  /var/log/nginx/gorodchaya.error.log;

    client_max_body_size 1m;

    location ~ /\.(?!well-known) { deny all; return 404; }

    location / { try_files \$uri \$uri/ =404; }

    # API магазина: /shop-api/api/... -> 127.0.0.1:4000/api/...
    location /shop-api/ {
        proxy_pass http://127.0.0.1:4000/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Чат с мастером
    location = /api/chat.php {
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $TC/public/api/chat.php;
        fastcgi_pass unix:$PHP_SOCK;
        fastcgi_read_timeout 40s;
    }

    # Админка (диалоги и заказы) — под паролем
    location = /admin { return 301 /admin/; }
    location ^~ /admin/ {
        client_max_body_size 12m;
        auth_basic "Chay Gorod admin";
        auth_basic_user_file $HT;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $TC/public/admin/index.php;
        fastcgi_param SCRIPT_NAME /admin/index.php;
        fastcgi_pass unix:$PHP_SOCK;
    }

    location ~ \.php\$ { return 404; }
}
NGXEOF
cat > /etc/nginx/sites-available/btxcap.conf <<NGXEOF
server {
    listen 80;
    listen [::]:80;
    server_name btxcap.ru www.btxcap.ru btxcap.online www.btxcap.online;

    root $BX/public;
    index index.html;

    access_log /var/log/nginx/btxcap.access.log;
    error_log  /var/log/nginx/btxcap.error.log;

    client_max_body_size 1m;

    location = /submit.php {
        try_files \$uri =404;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME \$document_root\$fastcgi_script_name;
        fastcgi_pass unix:$PHP_SOCK;
        fastcgi_read_timeout 25s;
    }
    location ~ \.php\$ { return 404; }
    location ~ /\.(?!well-known) { deny all; return 404; }
    location / { try_files \$uri \$uri/ =404; }
}
NGXEOF
install -m 644 "$HERE/deploy/nginx-tea-routes.conf" /etc/nginx/snippets/chaygorod-tea-routes.conf
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/gorodchaya.conf /etc/nginx/sites-enabled/gorodchaya.conf
ln -sf /etc/nginx/sites-available/btxcap.conf /etc/nginx/sites-enabled/btxcap.conf
nginx -t
systemctl enable nginx >/dev/null
systemctl reload nginx

step "9/9 Файрвол и ежедневный бэкап"
SSH_PORT="$(sshd -T 2>/dev/null | awk '$1=="port"{print $2; exit}')"
ufw allow "${SSH_PORT:-22}/tcp" >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
cat > /usr/local/bin/chaygorod-backup <<'BKEOF'
#!/usr/bin/env bash
# Ежедневный архив всего, что нельзя восстановить из кода: заказы, пользователи,
# каталог, диалоги, логи чата, секреты, конфиги nginx. Хранится 14 дней.
set -euo pipefail
DST=/var/backups/chaygorod
mkdir -p "$DST"; chmod 700 "$DST"
tar czf "$DST/chaygorod-$(date +%F).tar.gz" --ignore-failed-read \
  /var/www/chainy-gorod-backend/data \
  /var/www/tea-consultant/.env /var/www/tea-consultant/storage /var/www/tea-consultant/logs \
  /var/www/tea-consultant/data /var/www/tea-consultant/prompts \
  /var/www/btxcap/config.php /var/www/btxcap/private-state \
  /etc/chainy-gorod-backend.env /etc/nginx/sites-available /etc/nginx/.htpasswd-tea-admin \
  /etc/letsencrypt 2>/dev/null
find "$DST" -name 'chaygorod-*.tar.gz' -mtime +14 -delete
BKEOF
chmod 750 /usr/local/bin/chaygorod-backup
echo "30 3 * * * root /usr/local/bin/chaygorod-backup" > /etc/cron.d/chaygorod-backup
/usr/local/bin/chaygorod-backup || true

step "Проверка"
ok() { printf '  %-42s %s\n' "$1" "$2"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
ok "Главная (gorodchaya.ru)"        "$(code -H 'Host: gorodchaya.ru' http://127.0.0.1/)"
ok "Каталог API /shop-api/api/teas" "$(code -H 'Host: gorodchaya.ru' http://127.0.0.1/shop-api/api/teas)"
ok "Чаёв в каталоге"                "$(curl -s http://127.0.0.1:4000/api/teas | grep -o '"externalId"' | wc -l)"
ok "Страниц tea-*.html"             "$(ls $SITE/tea-*.html 2>/dev/null | wc -l)"
ok "Админка без пароля (ждём 401)"  "$(code -H 'Host: gorodchaya.ru' http://127.0.0.1/admin/)"
ok "Чат (ждём 200)"                 "$(code -H 'Host: gorodchaya.ru' -H 'Content-Type: application/json' -d '{"message":"Привет"}' http://127.0.0.1/api/chat.php)"
ok "CRM.Капитан (btxcap.ru)"        "$(code -H 'Host: btxcap.ru' http://127.0.0.1/)"

echo
echo "Готово. Пароль админки и напоминания: $CRED"
cat "$CRED" 2>/dev/null || true
echo "Дальше: 1) направить A-записи доменов на этот сервер; 2) bash $HERE/ssl.sh ваша@почта"
echo "        3) вписать TELEGRAM_BOT_TOKEN в $BE_ENV и: systemctl restart chainy-gorod-backend"
echo "        4) заполнить $BX/config.php (почта и вебхук Битрикс24)"
