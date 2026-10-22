#!/usr/bin/env bash
# Обновление уже установленного сервера из этого репозитория:
# витрина, генератор страниц, бэкенд магазина, консультант и админка,
# маршруты nginx для /tea/ и /t/. Обычно запускается через deploy.sh.
#   bash update.sh "ИП Иванов Иван Иванович, ИНН 000000000000" "почта@для-обращений.ru"
# (оператор и почта нужны один раз — дальше берутся из /etc/chaygorod-operator.env)
# Не трогает: секреты (.env, ключи), заказы, пользователей, каталог чаёв,
# диалоги, логи, конфиг CRM.Капитан, сертификаты.
set -euo pipefail
OPERATOR="${1:-}"; EMAIL="${2:-}"
CONF=/etc/chaygorod-operator.env
if [ -z "$OPERATOR" ] && [ -f "$CONF" ]; then . "$CONF"; fi
if [ -z "$OPERATOR" ] || [ -z "$EMAIL" ] || ! printf '%s' "$EMAIL" | grep -q '@'; then
  echo 'Укажите оператора и почту: bash update.sh "ИП Иванов И. И., ИНН ..." "почта@..."' >&2; exit 1
fi
printf 'OPERATOR=%q\nEMAIL=%q\n' "$OPERATOR" "$EMAIL" > "$CONF"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE=/var/www/chainy-gorod-site; GEN=/opt/chainy-gorod-generator
BE=/var/www/chainy-gorod-backend; TC=/var/www/tea-consultant
NGX=/etc/nginx/sites-available/gorodchaya.conf
STAMP="$(date +%F-%H%M)"
step() { echo; echo "=== $* ==="; }

step "Витрина и генератор"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cp -a "$HERE/site" "$TMP/site"; cp -a "$HERE/generator" "$TMP/generator"
OPERATOR="$OPERATOR" EMAIL="$EMAIL" python3 - "$TMP" <<'PY'
import os, sys, html, json, datetime
tmp = sys.argv[1]; op = os.environ['OPERATOR']; em = os.environ['EMAIL']
date = datetime.date.today().strftime('%d.%m.%Y')
for rel, esc in [('site/privacy.html', html.escape), ('site/consent.html', html.escape),
                 ('site/assets/common.js', lambda s: json.dumps(s, ensure_ascii=False)[1:-1].replace("'", "\\'")),
                 ('generator/src/assets/common.js', lambda s: json.dumps(s, ensure_ascii=False)[1:-1].replace("'", "\\'"))]:
    p = os.path.join(tmp, rel); s = open(p, encoding='utf8').read()
    s = s.replace('{{OPERATOR_EMAIL}}', esc(em)).replace('{{OPERATOR}}', esc(op)).replace('{{DATE}}', date)
    assert '{{' not in s or rel.endswith('.js'), rel
    open(p, 'w', encoding='utf8').write(s)
PY
node --check "$TMP/site/assets/common.js"
rsync -a "$TMP/site/" "$SITE/"
chown -R www-data:www-data "$SITE"
find "$SITE" -type d -exec chmod 755 {} \; ; find "$SITE" -type f -exec chmod 644 {} \;
rsync -a "$TMP/generator/" "$GEN/"; chmod -R a+rX "$GEN"

step "Консультант и админка"
# data/teas.json теперь выгружает бэкенд из каталога — из репозитория не перезаписываем.
if [ -f "$TC/data/teas.json" ] && ! ls "$TC"/data/teas.json.bak-* >/dev/null 2>&1; then
  cp -p "$TC/data/teas.json" "$TC/data/teas.json.bak-$STAMP"
fi
rsync -a --exclude '.env' --exclude 'storage/' --exclude 'logs/' --exclude 'data/' "$HERE/tea-consultant/" "$TC/"
chown -R www-data:www-data "$TC"
find "$TC" -type d -exec chmod 750 {} \; ; find "$TC" -type f -exec chmod 640 {} \;
chmod -R 770 "$TC/storage" "$TC/logs"; chmod 600 "$TC/.env"; chmod 750 "$TC/deploy/"*.sh
find "$TC" -name '*.php' -print0 | xargs -0 -n1 php -l >/dev/null
PHP_VER="$(ls /run/php/php*-fpm.sock 2>/dev/null | grep -o 'php[0-9.]*-fpm' | sort -V | tail -1 | sed 's/php//; s/-fpm//')"
if [ -n "$PHP_VER" ] && [ -d "/etc/php/$PHP_VER/fpm/conf.d" ]; then
  install -m 644 "$HERE/deploy/php-admin-upload.ini" "/etc/php/$PHP_VER/fpm/conf.d/99z-chaygorod-admin-upload.ini"
  systemctl reload "php$PHP_VER-fpm"
fi

step "Бэкенд магазина"
bash "$HERE/snapshot.sh" before-deploy || echo "Снимок данных не сделан — продолжаем."
cp "$BE/server.js" "$BE/server.js.bak-$STAMP"
cp "$HERE"/backend/*.js "$HERE/backend/package.json" "$BE/"
chown www-data:www-data "$BE"/*.js "$BE/package.json"
node --check "$BE/server.js"
systemctl restart chainy-gorod-backend
for i in $(seq 1 15); do curl -fsS http://127.0.0.1:4000/api/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:4000/api/health >/dev/null || { journalctl -u chainy-gorod-backend -n 20 --no-pager; echo "Бэкенд не поднялся — верните $BE/server.js.bak-$STAMP" >&2; exit 1; }

step "nginx: ссылки /tea/ и /t/, лимит для фото в админке"
install -m 644 "$HERE/deploy/nginx-tea-routes.conf" /etc/nginx/snippets/chaygorod-tea-routes.conf
cp -p "$NGX" "/root/gorodchaya.conf.bak-$STAMP"
grep -q 'chaygorod-tea-routes.conf' "$NGX" || \
  sed -i '/root \/var\/www\/chainy-gorod-site;/a\    include snippets/chaygorod-tea-routes.conf;' "$NGX"
grep -q 'client_max_body_size 12m' "$NGX" || \
  sed -i '/location \^~ \/admin\/ {/a\        client_max_body_size 12m;' "$NGX"
if nginx -t 2>/tmp/nginx-test.log; then
  systemctl reload nginx
else
  cat /tmp/nginx-test.log; cp -p "/root/gorodchaya.conf.bak-$STAMP" "$NGX"
  echo "nginx не принял изменения — конфиг возвращён как был." >&2; exit 1
fi

step "Страницы чаёв и знания мастера"
sleep 3   # бэкенд при старте сам перепекает страницы и выгружает базу мастера
KEY="$(grep -E '^API_KEY=' /etc/chainy-gorod-backend.env | cut -d= -f2-)"
curl -s -X POST -H "x-api-key: $KEY" http://127.0.0.1:4000/api/admin/catalog-sync >/dev/null
sleep 4
curl -s -H "x-api-key: $KEY" http://127.0.0.1:4000/api/admin/catalog-status; echo

step "Проверка"
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
FIRST="$(curl -s http://127.0.0.1:4000/api/teas | python3 -c 'import json,sys; t=json.load(sys.stdin)[0]; print(t["slug"], t["externalId"])')"
SLUG="${FIRST% *}"; NUM="${FIRST#* }"
printf '  %-40s %s\n' "Страница /tea/$SLUG (ждём 200)" "$(code -k -H 'Host: gorodchaya.ru' "https://127.0.0.1/tea/$SLUG")"
printf '  %-40s %s\n' "Короткая /t/$NUM (ждём 301)" "$(code -k -H 'Host: gorodchaya.ru' "https://127.0.0.1/t/$NUM")"
printf '  %-40s %s\n' "Админка без пароля (ждём 401)" "$(code -k -H 'Host: gorodchaya.ru' 'https://127.0.0.1/admin/?tab=products')"
printf '  %-40s %s\n' "Политика (ждём 200)" "$(code -k -H 'Host: gorodchaya.ru' https://127.0.0.1/privacy.html)"
echo "Готово. Оператор: $OPERATOR, почта: $EMAIL"
