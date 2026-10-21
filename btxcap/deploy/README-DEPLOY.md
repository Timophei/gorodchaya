# Разворачивание CRM.Капитан на gorodchaya.ru

Домены: btxcap.ru, btxcap.online (можно оба сразу на один сайт).
Схема — та же, что у tea-consultant / chainy-gorod: отдельный каталог в /var/www,
отдельный nginx server block, общий PHP-FPM (php8.3-fpm.sock), сертификат через certbot.
Docker не нужен.

## 1. Закинуть архив на сервер

В обычном Terminal на своём Mac (не в этом чате):

```
scp ~/Downloads/crm-kapitan-deploy.zip root@gorodchaya.ru:/var/www/
```

(поправьте путь, если скачали архив в другое место)

## 2. Зайти на сервер и распаковать

```
ssh root@gorodchaya.ru
cd /var/www
mkdir -p btxcap
unzip -o crm-kapitan-deploy.zip -d btxcap
mv btxcap/crm-kapitan/* btxcap/ 2>/dev/null
rmdir btxcap/crm-kapitan 2>/dev/null || true
```

После этого в /var/www/btxcap должны быть: public/, config.example.php, README.md, deploy/.

## 3. Запустить настройку

```
bash /var/www/btxcap/deploy/setup-btxcap.sh
```

Скрипт выставит права www-data:www-data, создаст config.php из шаблона (если его ещё нет),
пропишет nginx server block и перечитает nginx.

## 4. Заполнить config.php

```
nano /var/www/btxcap/config.php
```

Впишите `recipient` (куда слать заявки), `from` (отправитель на этом домене),
`webhook` (входящий вебхук Битрикс24 вида https://ваш.bitrix24.ru/rest/USER/SECRET/),
при необходимости `assigned_by_id`. Подробности — в /var/www/btxcap/README.md.

## 5. HTTPS

Убедитесь, что A-записи btxcap.ru и btxcap.online уже указывают на этот сервер, затем:

```
certbot --nginx -d btxcap.ru -d btxcap.online
```

(добавьте `-d www.btxcap.ru -d www.btxcap.online`, если эти www-поддомены тоже в DNS)

certbot сам допишет в /etc/nginx/sites-available/btxcap.conf SSL-блок и редирект с 80 на 443 —
как это уже сделано у tea-consultant.

## 6. Проверка

Откройте https://btxcap.ru, отправьте тестовую заявку, проверьте:
- письмо дошло на recipient;
- лид создался в Битрикс24 (CRM.Капитан — заявка на курс).
