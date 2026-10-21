# Чайный город

Интернет-магазин чая с консультантом-мастером (gorodchaya.ru, gorodchaya.online) и лендинг CRM.Капитан (btxcap.ru, btxcap.online). Всё живёт на одном сервере Ubuntu 24.04: nginx, PHP-FPM, Node.js, без Docker.

## Что где

| Папка | Что это | На сервере |
|---|---|---|
| `site/` | Витрина: страницы, стили, `assets/common.js` (корзина, шапка, метка посетителя) | `/var/www/chainy-gorod-site` |
| `backend/` | API магазина (Node/Express, хранение в JSON): каталог, заказы, вход через Telegram, посетители | `/var/www/chainy-gorod-backend`, сервис `chainy-gorod-backend`, порт 4000 |
| `generator/` | Печёт `tea-<id>.html` и `sitemap.xml` из каталога (раз в час по cron) | `/opt/chainy-gorod-generator` |
| `tea-consultant/` | Чат с мастером (PHP + OpenAI) и админка `/admin/` (диалоги, заказы, пользователи) | `/var/www/tea-consultant` |
| `btxcap/` | Лендинг CRM.Капитан с формой заявки в Битрикс24 | `/var/www/btxcap` |

## Установка с нуля

```
bash install.sh              # пакеты, сайты, сервисы, nginx, файрвол, ежедневный бэкап
bash ssl.sh почта@пример.ru  # сертификаты, когда DNS доменов указывает на сервер
```

`install.sh` повторно запускать безопасно, но он перезаписывает конфиги nginx: после него снова запустите `ssl.sh`.

## Обновление работающего сервера

```
bash update.sh "ФИО или ИП оператора данных" "почта@для-обращений.ru"
```

Оператор и почта подставляются в политику конфиденциальности и подвал; при следующих запусках берутся из `/etc/chaygorod-operator.env`. Nginx, секреты, заказы и диалоги скрипт не трогает.

## Секреты (в репозитории их нет)

| Файл на сервере | Что внутри |
|---|---|
| `/var/www/tea-consultant/.env` | `OPENAI_API_KEY` и настройки чата (шаблон: `tea-consultant/.env.example`), `CHAYGOROD_API_KEY` |
| `/etc/chainy-gorod-backend.env` | `API_KEY`, `SESSION_SECRET`, `TELEGRAM_BOT_TOKEN` |
| `/var/www/btxcap/config.php` | Почта для заявок и вебхук Битрикс24 (шаблон: `btxcap/config.example.php`) |
| `/etc/nginx/.htpasswd-tea-admin` | Пароль админки |

## В планах

Синхронизация с коробочным Битрикс24: цены и остатки по полю «ID на сайте» вида `110-50` (номер чая, граммовка), заказы как сделки в воронке «Чайный город», статус «В наличии / Под заказ» без ограничений на покупку.
