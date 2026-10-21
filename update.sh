#!/usr/bin/env bash
# Обновление уже установленного сервера из этого репозитория:
# витрина, генератор страниц, бэкенд магазина, админка консультанта.
#   bash update.sh "ИП Иванов Иван Иванович, ИНН 000000000000" "почта@для-обращений.ru"
# nginx, секреты, заказы и диалоги не трогает.
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
cp "$BE/server.js" "$BE/server.js.bak-$(date +%F-%H%M)"
cp "$HERE"/backend/*.js "$BE/"; chown www-data:www-data "$BE"/*.js
node --check "$BE/server.js"
systemctl restart chainy-gorod-backend
for i in $(seq 1 15); do curl -fsS http://127.0.0.1:4000/api/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:4000/api/health >/dev/null || { journalctl -u chainy-gorod-backend -n 20 --no-pager; echo "Бэкенд не поднялся — верните server.js из .bak" >&2; exit 1; }
install -o www-data -g www-data -m 640 "$HERE/tea-consultant/public/admin/index.php" "$TC/public/admin/index.php"
php -l "$TC/public/admin/index.php" >/dev/null
rsync -a "$TMP/site/" "$SITE/"
chown -R www-data:www-data "$SITE"
find "$SITE" -type d -exec chmod 755 {} \; ; find "$SITE" -type f -exec chmod 644 {} \;
rsync -a "$TMP/generator/" "$GEN/"; chmod -R a+rX "$GEN"
/usr/local/bin/chaygorod-generate | tail -2
KEY="$(grep -E '^API_KEY=' /etc/chainy-gorod-backend.env | cut -d= -f2-)"
echo "API пользователей: $(curl -s -o /dev/null -w '%{http_code}' -H "x-api-key: $KEY" http://127.0.0.1:4000/api/admin/people) (ждём 200)"
echo "Политика: $(curl -s -o /dev/null -w '%{http_code}' -H 'Host: gorodchaya.ru' -k https://127.0.0.1/privacy.html) (ждём 200), оператор: $OPERATOR, почта: $EMAIL"
echo "Готово."
