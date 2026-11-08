<?php

declare(strict_types=1);

/**
 * Вкладка «Настройки» (?tab=settings): самовывоз, доставка, бот уведомлений
 * о заказах, ключ подсказок адреса. Хранятся в бэкенде витрины
 * (data/settings.json), сюда приходят без токенов — только «задан / не задан».
 * Подключается из index.php.
 */

/** @return array{settings: ?array, errors: array, flash: ?string, link: ?string, apiError: ?string} */
function settingsHandle(): array
{
    $state = ['settings' => null, 'errors' => [], 'flash' => null, 'link' => null, 'apiError' => null];

    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        if (!productsSameOrigin()) {
            http_response_code(403);
            exit('Запрос отклонён: отправлен не со страницы админки.');
        }
        $action = (string) ($_POST['action'] ?? '');
        $p = $_POST;
        $go = static function (string $flash): void {
            header('Location: ?tab=settings&ok=' . rawurlencode($flash));
            exit;
        };

        if ($action === 'save_delivery') {
            $money = static fn ($v) => (int) preg_replace('/\D/', '', (string) $v);
            $free = trim((string) ($p['city_free_from'] ?? ''));
            $body = [
                'pickup' => [
                    'enabled' => isset($p['pickup_enabled']),
                    'city' => trim((string) ($p['pickup_city'] ?? '')),
                    'address' => trim((string) ($p['pickup_address'] ?? '')),
                    'hours' => trim((string) ($p['pickup_hours'] ?? '')),
                ],
                'delivery' => [
                    'city' => [
                        'enabled' => isset($p['city_enabled']),
                        'name' => trim((string) ($p['city_name'] ?? '')),
                        'price' => $money($p['city_price'] ?? 0),
                        'freeFrom' => $free === '' ? null : $money($free),
                        'note' => trim((string) ($p['city_note'] ?? '')),
                    ],
                    'russia' => [
                        'enabled' => isset($p['russia_enabled']),
                        'note' => trim((string) ($p['russia_note'] ?? '')),
                    ],
                ],
            ];
            $r = ordersApiRequest('POST', '/admin/settings', $body);
            if ($r['ok']) { $go('Доставка и самовывоз сохранены.'); }
            $state['errors'] = settingsErrors($r);
        } elseif ($action === 'save_bot') {
            $token = trim((string) ($p['bot_token'] ?? ''));
            $body = isset($p['bot_clear']) ? ['notifyBotToken' => null] : ['notifyBotToken' => $token];
            $r = ordersApiRequest('POST', '/admin/settings', $body);
            if ($r['ok']) {
                if ($token !== '') {
                    $c = ordersApiRequest('POST', '/admin/settings/notify/check', []);
                    if (!$c['ok']) {
                        $state['errors'] = ['Токен сохранён, но Telegram его не принял: ' . ($c['data']['message'] ?? $c['error'] ?? 'ошибка')];
                    } else {
                        $go('Бот подключён: @' . ($c['data']['bot']['username'] ?? '') . '. Откройте ссылку подписки на телефоне.');
                    }
                } else {
                    $go(isset($p['bot_clear']) ? 'Токен бота удалён — уведомления выключены.' : 'Сохранено.');
                }
            } else {
                $state['errors'] = settingsErrors($r);
            }
        } elseif ($action === 'bot_check') {
            $c = ordersApiRequest('POST', '/admin/settings/notify/check', []);
            if ($c['ok']) { $go('Бот на связи: @' . ($c['data']['bot']['username'] ?? '')); }
            $state['errors'] = ['Telegram не ответил: ' . ($c['data']['message'] ?? $c['error'] ?? 'ошибка')];
        } elseif ($action === 'bot_test') {
            $t = ordersApiRequest('POST', '/admin/settings/notify/test', []);
            $sent = (int) ($t['data']['sent'] ?? 0);
            $failed = (int) ($t['data']['failed'] ?? 0);
            if ($t['ok'] && $sent > 0) { $go("Проверочное сообщение отправлено ({$sent})." . ($failed ? " Не дошло: {$failed}." : '')); }
            $state['errors'] = [$sent === 0 && $failed === 0 ? 'Некому отправлять: сначала подпишитесь по ссылке.' : 'Сообщение не дошло — проверьте токен.'];
        } elseif ($action === 'bot_new_code') {
            ordersApiRequest('POST', '/admin/settings/notify/new-code', []);
            $go('Ссылка подписки заменена. Старая больше не работает, уже подписанные остаются.');
        } elseif ($action === 'bot_unsubscribe') {
            $chat = preg_replace('/[^0-9-]/', '', (string) ($p['chat_id'] ?? ''));
            ordersApiRequest('DELETE', '/admin/settings/notify/subscribers/' . rawurlencode((string) $chat));
            $go('Подписчик удалён.');
        } elseif ($action === 'save_dadata') {
            $token = trim((string) ($p['dadata_token'] ?? ''));
            $body = isset($p['dadata_clear']) ? ['dadataToken' => null] : ['dadataToken' => $token];
            $r = ordersApiRequest('POST', '/admin/settings', $body);
            if ($r['ok']) { $go(isset($p['dadata_clear']) ? 'Ключ DaData удалён — подсказки адреса выключены.' : 'Ключ DaData сохранён.'); }
            $state['errors'] = settingsErrors($r);
        }
    }

    if (isset($_GET['ok']) && is_string($_GET['ok'])) { $state['flash'] = mb_substr($_GET['ok'], 0, 300); }

    $r = ordersApiRequest('GET', '/admin/settings');
    if ($r['ok'] && is_array($r['data'])) {
        $state['settings'] = $r['data'];
        $n = $r['data']['notify'] ?? [];
        if (!empty($n['botUsername']) && !empty($n['subscribeCode'])) {
            $state['link'] = 'https://t.me/' . $n['botUsername'] . '?start=' . $n['subscribeCode'];
        }
    } else {
        $state['apiError'] = $r['error'] ?? 'Не удалось получить настройки';
    }
    return $state;
}

function settingsErrors(array $r): array
{
    $out = [];
    foreach ((array) ($r['data']['details'] ?? []) as $d) {
        $out[] = (string) ($d['message'] ?? 'ошибка');
    }
    return $out ?: [(string) ($r['error'] ?? 'Ошибка сохранения')];
}

function settingsRender(array $state): void
{
    if ($state['apiError']) {
        echo '<div class="api-error">' . esc($state['apiError']) . '</div>';
        return;
    }
    $s = $state['settings'];
    $pk = $s['pickup'];
    $city = $s['delivery']['city'];
    $ru = $s['delivery']['russia'];
    $n = $s['notify'];
    $chk = static fn ($v) => $v ? 'checked' : '';
    ?>
    <?php if ($state['flash']): ?><div class="flash"><?= esc($state['flash']) ?></div><?php endif; ?>
    <?php foreach ($state['errors'] as $e): ?><div class="api-error"><?= esc($e) ?></div><?php endforeach; ?>

    <section class="set-card">
      <h2>Доставка и самовывоз</h2>
      <p class="set-hint">Что увидит покупатель в корзине. Выключенный способ в корзине не показывается.</p>
      <form method="post" action="?tab=settings">
        <input type="hidden" name="action" value="save_delivery">
        <fieldset>
          <legend><label><input type="checkbox" name="pickup_enabled" <?= $chk($pk['enabled']) ?>> Самовывоз из чайной</label></legend>
          <div class="set-grid">
            <label>Город<input name="pickup_city" value="<?= esc($pk['city']) ?>"></label>
            <label>Адрес чайной<input name="pickup_address" value="<?= esc($pk['address']) ?>" required></label>
            <label class="wide">Часы работы (необязательно)<input name="pickup_hours" value="<?= esc($pk['hours']) ?>" placeholder="ежедневно 10:00–21:00"></label>
          </div>
        </fieldset>
        <fieldset>
          <legend><label><input type="checkbox" name="city_enabled" <?= $chk($city['enabled']) ?>> Доставка по городу</label></legend>
          <div class="set-grid">
            <label>Город<input name="city_name" value="<?= esc($city['name']) ?>" required></label>
            <label>Стоимость, ₽<input name="city_price" inputmode="numeric" value="<?= esc($city['price']) ?>"></label>
            <label>Бесплатно от, ₽<input name="city_free_from" inputmode="numeric" value="<?= esc($city['freeFrom'] ?? '') ?>" placeholder="пусто — всегда платно"></label>
            <label class="wide">Пояснение<input name="city_note" value="<?= esc($city['note']) ?>" placeholder="привезём в течение дня"></label>
          </div>
        </fieldset>
        <fieldset>
          <legend><label><input type="checkbox" name="russia_enabled" <?= $chk($ru['enabled']) ?>> Доставка по России (транспортная компания)</label></legend>
          <div class="set-grid">
            <label class="wide">Пояснение<input name="russia_note" value="<?= esc($ru['note']) ?>"></label>
          </div>
          <p class="set-hint">Стоимость не известна заранее: в заказе будет пометка «доставка ТК — рассчитать и сообщить».</p>
        </fieldset>
        <button class="btn" type="submit">Сохранить</button>
      </form>
    </section>

    <section class="set-card">
      <h2>Уведомления о заказах в Telegram</h2>
      <p class="set-hint">Отдельный бот, только для сотрудников. 1) Создайте бота у <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> (команда /newbot) и вставьте токен. 2) Откройте ссылку подписки на телефоне и нажмите «Старт». Без этой ссылки бот никого не подписывает.</p>
      <form method="post" action="?tab=settings" class="set-inline">
        <input type="hidden" name="action" value="save_bot">
        <input name="bot_token" type="password" autocomplete="off" placeholder="<?= $n['botTokenSet'] ? 'токен задан — вставьте новый, чтобы заменить' : '123456789:AA…' ?>">
        <button class="btn" type="submit">Сохранить</button>
        <?php if ($n['botTokenSet']): ?><button class="link-btn" type="submit" name="bot_clear" value="1" onclick="return confirm('Удалить токен? Уведомления перестанут приходить.')">удалить токен</button><?php endif; ?>
      </form>
      <?php if ($n['botTokenSet']): ?>
        <div class="set-status">
          Бот: <?= $n['botUsername'] !== '' ? '<b>@' . esc($n['botUsername']) . '</b>' : 'имя не проверено' ?>
          <form method="post" action="?tab=settings" class="set-mini"><input type="hidden" name="action" value="bot_check"><button class="link-btn" type="submit">проверить</button></form>
        </div>
        <?php if ($state['link']): ?>
          <div class="set-status">Ссылка подписки: <a href="<?= esc($state['link']) ?>" target="_blank" rel="noopener"><?= esc($state['link']) ?></a>
            <form method="post" action="?tab=settings" class="set-mini" onsubmit="return confirm('Заменить ссылку? Старая перестанет работать.')"><input type="hidden" name="action" value="bot_new_code"><button class="link-btn" type="submit">заменить ссылку</button></form>
          </div>
        <?php endif; ?>
        <h3>Получают уведомления</h3>
        <?php if (!$n['subscribers']): ?>
          <div class="set-hint">Пока никто. Откройте ссылку подписки на телефоне.</div>
        <?php else: ?>
          <ul class="set-subs">
            <?php foreach ($n['subscribers'] as $sub): ?>
              <li><?= esc($sub['name'] ?? '') ?><?= !empty($sub['username']) ? ' · @' . esc($sub['username']) : '' ?> <span class="set-hint">с <?= esc(fmtTime($sub['at'] ?? null)) ?></span>
                <form method="post" action="?tab=settings" class="set-mini" onsubmit="return confirm('Отключить уведомления для этого чата?')"><input type="hidden" name="action" value="bot_unsubscribe"><input type="hidden" name="chat_id" value="<?= esc($sub['chatId'] ?? '') ?>"><button class="link-btn" type="submit">отключить</button></form>
              </li>
            <?php endforeach; ?>
          </ul>
          <form method="post" action="?tab=settings"><input type="hidden" name="action" value="bot_test"><button class="btn btn-light" type="submit">Отправить проверочное сообщение</button></form>
        <?php endif; ?>
      <?php endif; ?>
    </section>

    <section class="set-card">
      <h2>Подсказки адреса (DaData)</h2>
      <p class="set-hint">Когда покупатель вводит адрес, под полем появляются варианты. Ключ API — в личном кабинете <a href="https://dadata.ru" target="_blank" rel="noopener">dadata.ru</a> → «API-ключ». Ключ остаётся на сервере и в браузер покупателя не попадает. Без ключа адрес просто вводится вручную.</p>
      <form method="post" action="?tab=settings" class="set-inline">
        <input type="hidden" name="action" value="save_dadata">
        <input name="dadata_token" type="password" autocomplete="off" placeholder="<?= $s['dadata']['tokenSet'] ? 'ключ задан — вставьте новый, чтобы заменить' : 'API-ключ' ?>">
        <button class="btn" type="submit">Сохранить</button>
        <?php if ($s['dadata']['tokenSet']): ?><button class="link-btn" type="submit" name="dadata_clear" value="1">удалить ключ</button><?php endif; ?>
      </form>
      <div class="set-status">Сейчас: <?= $s['dadata']['tokenSet'] ? '<b>подсказки включены</b>' : 'выключены' ?></div>
    </section>
    <?php
}

function settingsCss(): string
{
    return <<<'CSS'
<style>
  .set-card { background: var(--tea-paper); border: 1px solid var(--tea-border); border-radius: 14px; padding: 18px 20px; margin-bottom: 18px; }
  .set-card h2 { font-size: 16px; margin: 0 0 6px; color: var(--tea-green-dark); }
  .set-card h3 { font-size: 13.5px; margin: 16px 0 6px; }
  .set-hint { font-size: 12.5px; color: var(--tea-muted); margin: 4px 0 10px; line-height: 1.45; }
  .set-card fieldset { border: 1px solid var(--tea-border); border-radius: 10px; padding: 10px 14px 12px; margin: 0 0 12px; }
  .set-card legend { font-size: 13.5px; font-weight: 700; padding: 0 6px; }
  .set-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
  .set-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--tea-muted); }
  .set-grid label.wide { grid-column: 1 / -1; }
  .set-card input[type=text], .set-card input:not([type]), .set-card input[type=password], .set-card textarea, .set-card select {
    border: 1px solid var(--tea-border); border-radius: 8px; padding: 7px 10px; font: inherit; font-size: 13.5px; color: var(--tea-text); background: #fff; }
  .set-inline { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .set-inline input { flex: 1; min-width: 220px; }
  .set-status { font-size: 13px; margin-top: 10px; display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline; word-break: break-all; }
  .set-mini { display: inline; }
  .set-subs { margin: 0 0 12px; padding-left: 18px; font-size: 13.5px; }
  .set-subs li { margin-bottom: 4px; }
  .btn-light { background: #fff !important; color: var(--tea-green-dark) !important; border: 1px solid var(--tea-green) !important; }
  .flash { background: #eef3e6; border: 1px solid #cfdcc0; color: var(--tea-green-dark); border-radius: 10px; padding: 10px 14px; margin-bottom: 14px; font-size: 13.5px; }
</style>
CSS;
}
