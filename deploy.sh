#!/usr/bin/env bash
# Забрать свежую версию с GitHub и поставить её:
#   bash /opt/gorodchaya/deploy.sh
# Первый раз на сервере:
#   git clone https://github.com/Timophei/gorodchaya /opt/gorodchaya && bash /opt/gorodchaya/deploy.sh
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
git -C "$REPO" pull --ff-only
echo "Версия: $(git -C "$REPO" log --oneline -1)"
exec bash "$REPO/update.sh" "$@"
