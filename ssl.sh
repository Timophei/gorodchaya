#!/usr/bin/env bash
# Выпуск HTTPS-сертификатов. Запускать ПОСЛЕ того, как A-записи доменов указывают на этот сервер.
#   bash ssl.sh ваша@почта      (почта — для уведомлений Let's Encrypt; можно без неё)
set -euo pipefail
EMAIL="${1:-}"
MYIP="$(curl -4 -fsS https://api.ipify.org || hostname -I | awk '{print $1}')"
echo "IP сервера: $MYIP"
issue() {
  local args=()
  for d in "$@"; do
    ip="$(getent ahostsv4 "$d" | awk '{print $1; exit}')"
    if [ "$ip" = "$MYIP" ]; then args+=(-d "$d"); echo "  $d -> $ip  ок"
    else echo "  $d -> ${ip:-нет записи}  ПРОПУСК (DNS ещё не указывает сюда)"; fi
  done
  [ ${#args[@]} -gt 0 ] || { echo "  нечего выпускать"; return 0; }
  if [ -n "$EMAIL" ]; then mail=(-m "$EMAIL"); else mail=(--register-unsafely-without-email); fi
  certbot --nginx --non-interactive --agree-tos "${mail[@]}" --redirect --expand "${args[@]}"
}
echo "== gorodchaya.ru =="; issue gorodchaya.ru www.gorodchaya.ru gorodchaya.online www.gorodchaya.online
echo "== btxcap =="; issue btxcap.ru www.btxcap.ru btxcap.online www.btxcap.online
systemctl reload nginx
certbot renew --dry-run >/dev/null 2>&1 && echo "Автопродление сертификатов работает."
