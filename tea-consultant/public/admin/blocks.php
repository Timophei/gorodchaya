<?php

declare(strict_types=1);

/**
 * Вкладка «Блоки» (?tab=blocks, ?tab=blocks&b=<блок>) — упрощённый редактор
 * сайта: шапка, главный чат, первая витрина, Чайная гильдия, подвал.
 * Сохранение сразу на живой сайт; каждая правка уходит в историю, к любой
 * версии можно откатиться. Данные — в бэкенде (data/site-blocks.json).
 */

const BLOCKS_ORDER = ['header', 'chat', 'productChat', 'showcase', 'guild', 'footer'];
const BLOCKS_HINTS = [
    'header' => 'Логотип, пункты меню (порядок, названия, видимость), цитата справа.',
    'chat' => 'Приветствие мастера, быстрые кнопки под полем ввода, кнопка «в каталог».',
    'productChat' => 'Чат с мастером справа от цены на странице каждого чая: заголовок, приветствие, быстрые вопросы.',
    'showcase' => 'Заголовок, описание и какие чаи показать: популярные, категория или вручную.',
    'guild' => 'Баннер «Чайная гильдия» на главной.',
    'footer' => 'Пункты подвала, контакты, соцсети, реквизиты.',
];

/** @return array{cfg: ?array, history: array, names: array, block: ?string, errors: array, flash: ?string, apiError: ?string, teas: array, categories: array} */
function blocksHandle(): array
{
    $state = ['cfg' => null, 'history' => [], 'names' => [], 'block' => null, 'errors' => [], 'flash' => null, 'apiError' => null, 'teas' => [], 'categories' => []];
    $block = isset($_GET['b']) && in_array($_GET['b'], BLOCKS_ORDER, true) ? (string) $_GET['b'] : null;
    $state['block'] = $block;

    $r = ordersApiRequest('GET', '/admin/site-config');
    if (!$r['ok'] || !is_array($r['data'])) {
        $state['apiError'] = $r['error'] ?? 'Не удалось получить настройки блоков';
        return $state;
    }
    $cfg = $r['data']['current'];

    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        if (!productsSameOrigin()) {
            http_response_code(403);
            exit('Запрос отклонён: отправлен не со страницы админки.');
        }
        $p = $_POST;
        $action = (string) ($p['action'] ?? '');
        $back = static function (?string $b, string $flash): void {
            header('Location: ?tab=blocks' . ($b ? '&b=' . $b : '') . '&ok=' . rawurlencode($flash));
            exit;
        };
        $res = null;
        if ($action === 'toggle' && in_array($p['block'] ?? '', ['chat', 'productChat', 'showcase', 'guild', 'footer'], true)) {
            $b = (string) $p['block'];
            $body = $cfg[$b];
            $body['enabled'] = ($p['enabled'] ?? '') === '1';
            $res = ordersApiRequest('POST', '/admin/site-config/' . $b, $body);
            if ($res['ok']) { $back(null, ($r['data']['names'][$b] ?? $b) . ($body['enabled'] ? ' — включён.' : ' — выключен.')); }
        } elseif ($action === 'rollback') {
            $id = preg_replace('/[^a-f0-9]/', '', (string) ($p['version'] ?? ''));
            $res = ordersApiRequest('POST', '/admin/site-config/rollback/' . $id, []);
            if ($res['ok']) { $back(null, 'Откатили. Текущая версия сохранена в истории — её тоже можно вернуть.'); }
        } elseif ($action === 'logo') {
            $f = $_FILES['logo'] ?? null;
            $info = is_array($f) && ($f['error'] ?? 1) === UPLOAD_ERR_OK ? @getimagesize($f['tmp_name']) : false;
            $mime = is_array($info) ? (string) ($info['mime'] ?? '') : '';
            if (!in_array($mime, ['image/jpeg', 'image/png', 'image/webp'], true)) {
                $state['errors'][] = 'Нужна картинка PNG, JPEG или WebP.';
            } else {
                $res = productsApiRaw('/admin/site-config/logo', $mime, (string) file_get_contents($f['tmp_name']));
                if ($res['ok']) { $back('header', 'Логотип обновлён.'); }
            }
        } elseif ($action === 'logo_reset') {
            $body = $cfg['header'];
            $body['logoUrl'] = null;
            $res = ordersApiRequest('POST', '/admin/site-config/header', blocksStrip($body));
            if ($res['ok']) { $back('header', 'Вернули фирменный логотип.'); }
        } elseif ($action === 'save' && $block !== null) {
            $body = blocksBodyFromPost($block, $p, $cfg[$block]);
            $res = ordersApiRequest('POST', '/admin/site-config/' . $block, $body);
            if ($res['ok']) { $back($block, 'Сохранено — уже на сайте.'); }
            $cfg[$block] = array_merge($cfg[$block], $body); // показать введённое
        }
        if ($res !== null && !$res['ok']) { $state['errors'] = array_merge($state['errors'], settingsErrors($res)); }
    }

    if (isset($_GET['ok']) && is_string($_GET['ok'])) { $state['flash'] = mb_substr($_GET['ok'], 0, 300); }
    $state['cfg'] = $cfg;
    $state['history'] = $r['data']['history'] ?? [];
    $state['names'] = $r['data']['names'] ?? [];
    if ($block === 'showcase') {
        $t = ordersApiRequest('GET', '/teas');
        $state['teas'] = $t['ok'] && is_array($t['data']) ? $t['data'] : [];
        usort($state['teas'], static fn ($a, $b) => strcmp((string) ($a['name'] ?? ''), (string) ($b['name'] ?? '')));
        $c = ordersApiRequest('GET', '/categories');
        $state['categories'] = $c['ok'] && is_array($c['data']) ? $c['data'] : [];
    }
    return $state;
}

/** Убрать служебные поля (href) перед отправкой: адреса пунктов задаёт бэкенд. */
function blocksStrip(array $header): array
{
    $header['menu'] = array_map(static fn ($m) => ['key' => $m['key'], 'label' => $m['label'], 'enabled' => (bool) $m['enabled']], $header['menu']);
    return $header;
}

/** Строки списка из формы: name="rows[i][field]", порядок — как в форме. */
function blocksRows(array $p, string $name): array
{
    $rows = [];
    foreach ((array) ($p[$name] ?? []) as $row) {
        if (is_array($row)) { $rows[] = $row; }
    }
    return $rows;
}

function blocksBodyFromPost(string $block, array $p, array $cur): array
{
    $txt = static fn ($k) => trim((string) ($p[$k] ?? ''));
    switch ($block) {
        case 'header':
            return [
                'logoUrl' => $cur['logoUrl'] ?? null,
                'quote' => str_replace("\r", '', $txt('quote')),
                'showQuote' => isset($p['showQuote']),
                'menu' => array_map(static fn ($r) => [
                    'key' => (string) ($r['key'] ?? ''), 'label' => trim((string) ($r['label'] ?? '')), 'enabled' => isset($r['enabled']),
                ], blocksRows($p, 'menu')),
            ];
        case 'chat':
            $chips = [];
            foreach (blocksRows($p, 'chips') as $r) {
                $label = trim((string) ($r['label'] ?? ''));
                if ($label !== '') { $chips[] = ['label' => $label, 'text' => trim((string) ($r['text'] ?? ''))]; }
            }
            return [
                'enabled' => isset($p['enabled']),
                'greeting' => $txt('greeting'),
                'chips' => $chips,
                'catalogButton' => isset($p['catalogButton']),
                'catalogButtonLabel' => $txt('catalogButtonLabel') ?: 'Сразу в каталог',
            ];
        case 'productChat':
            $chips = [];
            foreach (blocksRows($p, 'chips') as $r) {
                $label = trim((string) ($r['label'] ?? ''));
                if ($label !== '') { $chips[] = ['label' => $label, 'text' => trim((string) ($r['text'] ?? ''))]; }
            }
            return [
                'enabled' => isset($p['enabled']),
                'title' => $txt('title') ?: 'Спросите мастера',
                'greeting' => $txt('greeting'),
                'chips' => $chips,
            ];
        case 'showcase':
            $order = array_filter(array_map('trim', explode(',', (string) ($p['teaOrder'] ?? ''))));
            $picked = array_map('strval', (array) ($p['teaIds'] ?? []));
            // Порядок — как отмечали (скрытое поле), отмеченные без порядка — в конец.
            $teaIds = array_values(array_unique(array_merge(array_values(array_intersect($order, $picked)), $picked)));
            return [
                'enabled' => isset($p['enabled']),
                'title' => $txt('title'),
                'description' => $txt('description'),
                'source' => in_array($p['source'] ?? '', ['featured', 'category', 'manual'], true) ? $p['source'] : 'featured',
                'categoryId' => $txt('categoryId') ?: null,
                'teaIds' => $teaIds,
                'limit' => max(1, min(12, (int) ($p['limit'] ?? 4))),
                'showAllCard' => isset($p['showAllCard']),
            ];
        case 'guild':
            return ['enabled' => isset($p['enabled'])];
        case 'footer':
            return [
                'enabled' => isset($p['enabled']),
                'nav' => array_map(static fn ($r) => [
                    'key' => (string) ($r['key'] ?? ''), 'title' => trim((string) ($r['title'] ?? '')),
                    'sub' => trim((string) ($r['sub'] ?? '')), 'enabled' => isset($r['enabled']),
                ], blocksRows($p, 'nav')),
                'contacts' => [
                    'address' => $txt('address'), 'phone' => $txt('phone'), 'email' => $txt('email'),
                    'hours' => $txt('hours'), 'mapUrl' => $txt('mapUrl'),
                ],
                'socials' => ['telegram' => $txt('telegram'), 'vk' => $txt('vk'), 'whatsapp' => $txt('whatsapp')],
                'requisites' => $txt('requisites'),
                'copyright' => $txt('copyright'),
            ];
    }
    return [];
}

function blocksRender(array $state): void
{
    if ($state['apiError']) { echo '<div class="api-error">' . esc($state['apiError']) . '</div>'; return; }
    if ($state['flash']) { echo '<div class="flash">' . esc($state['flash']) . '</div>'; }
    foreach ($state['errors'] as $e) { echo '<div class="api-error">' . esc($e) . '</div>'; }
    if ($state['block'] !== null) {
        echo '<a class="back-link" href="?tab=blocks">← все блоки</a>';
        $fn = 'blocksForm' . ucfirst($state['block']);
        $fn($state['cfg'][$state['block']], $state);
        echo blocksScript();
        return;
    }
    $cfg = $state['cfg'];
    ?>
    <p class="set-hint">Блоки главной страницы и всего сайта, сверху вниз. Изменения сразу видны на сайте; прошлые версии — в истории ниже.</p>
    <div class="blk-list">
      <?php foreach (BLOCKS_ORDER as $b): ?>
        <?php $on = $b === 'header' ? true : !empty($cfg[$b]['enabled']); ?>
        <div class="blk-row<?= $on ? '' : ' off' ?>">
          <div class="blk-main">
            <b><?= esc($state['names'][$b] ?? $b) ?></b>
            <span class="set-hint"><?= esc(BLOCKS_HINTS[$b]) ?></span>
          </div>
          <?php if ($b !== 'header'): ?>
            <form method="post" action="?tab=blocks" class="set-mini">
              <input type="hidden" name="action" value="toggle"><input type="hidden" name="block" value="<?= esc($b) ?>">
              <input type="hidden" name="enabled" value="<?= $on ? '0' : '1' ?>">
              <button type="submit" class="switch<?= $on ? ' on' : '' ?>" title="<?= $on ? 'Выключить' : 'Включить' ?>" aria-label="<?= $on ? 'Выключить' : 'Включить' ?>"><span></span></button>
            </form>
          <?php else: ?>
            <span class="set-hint" style="margin:0">всегда</span>
          <?php endif; ?>
          <?php if ($b !== 'guild'): ?><a class="btn btn-light" href="?tab=blocks&b=<?= esc($b) ?>">Настроить</a><?php else: ?><span class="blk-gap"></span><?php endif; ?>
        </div>
      <?php endforeach; ?>
    </div>

    <section class="set-card" style="margin-top:20px;">
      <h2>История изменений</h2>
      <?php if (!$state['history']): ?>
        <div class="set-hint">Пока изменений не было.</div>
      <?php else: ?>
        <p class="set-hint">«Откатить» возвращает сайт к тому, каким он был в этот момент. Текущий вид при этом тоже сохраняется в историю.</p>
        <ul class="blk-hist">
          <?php foreach ($state['history'] as $h): ?>
            <li><span><?= esc(fmtTime($h['at'] ?? null)) ?> · <?= esc($h['label'] ?? '') ?></span>
              <form method="post" action="?tab=blocks" class="set-mini" onsubmit="return confirm('Вернуть сайт к этой версии?')">
                <input type="hidden" name="action" value="rollback"><input type="hidden" name="version" value="<?= esc($h['id'] ?? '') ?>">
                <button class="link-btn" type="submit">откатить</button>
              </form></li>
          <?php endforeach; ?>
        </ul>
      <?php endif; ?>
    </section>
    <?php
}

function blocksFormHeader(array $c, array $state): void
{
    $logo = !empty($c['logoUrl']) ? '/' . ltrim((string) $c['logoUrl'], '/') : '/assets/logo-full.png';
    ?>
    <section class="set-card">
      <h2>Логотип</h2>
      <img src="<?= esc($logo) ?>" alt="" style="max-height:64px;max-width:240px;display:block;margin-bottom:10px;background:#f4efe2;padding:6px;border-radius:8px;">
      <form method="post" enctype="multipart/form-data" action="?tab=blocks&b=header" class="set-inline">
        <input type="hidden" name="action" value="logo">
        <input type="file" name="logo" accept="image/png,image/jpeg,image/webp" required>
        <button class="btn" type="submit">Загрузить</button>
      </form>
      <?php if (!empty($c['logoUrl'])): ?>
        <form method="post" action="?tab=blocks&b=header" style="margin-top:8px;"><input type="hidden" name="action" value="logo_reset"><button class="link-btn" type="submit">вернуть фирменный логотип</button></form>
      <?php endif; ?>
      <p class="set-hint">PNG с прозрачным фоном, по высоте от 120 px. На сайте показывается высотой около 60 px.</p>
    </section>
    <form method="post" action="?tab=blocks&b=header">
      <input type="hidden" name="action" value="save">
      <section class="set-card">
        <h2>Меню</h2>
        <p class="set-hint">Порядок — стрелками, название — в поле, снятая галочка прячет пункт (и в мобильном меню тоже). Адреса пунктов не меняются.</p>
        <div class="blk-rows" data-rows>
          <?php foreach ($c['menu'] as $i => $m): ?>
            <div class="blk-item" data-row>
              <input type="hidden" name="menu[<?= $i ?>][key]" value="<?= esc($m['key']) ?>">
              <label class="blk-on"><input type="checkbox" name="menu[<?= $i ?>][enabled]" <?= !empty($m['enabled']) ? 'checked' : '' ?>></label>
              <input name="menu[<?= $i ?>][label]" value="<?= esc($m['label']) ?>" maxlength="40" required>
              <span class="set-hint blk-href"><?= esc($m['href'] ?? '') ?></span>
              <span class="blk-move"><button type="button" data-up title="Выше">↑</button><button type="button" data-down title="Ниже">↓</button></span>
            </div>
          <?php endforeach; ?>
        </div>
      </section>
      <section class="set-card">
        <h2>Цитата справа</h2>
        <label class="f-check"><input type="checkbox" name="showQuote" <?= !empty($c['showQuote']) ? 'checked' : '' ?>> Показывать</label>
        <div class="set-grid" style="margin-top:8px;"><label class="wide">Текст (перенос строки — Enter)<textarea name="quote" rows="2" maxlength="120"><?= esc($c['quote'] ?? '') ?></textarea></label></div>
      </section>
      <button class="btn" type="submit">Сохранить</button>
    </form>
    <?php
}

function blocksFormChat(array $c, array $state): void
{
    ?>
    <form method="post" action="?tab=blocks&b=chat">
      <input type="hidden" name="action" value="save">
      <section class="set-card">
        <h2>Главный чат</h2>
        <label class="f-check"><input type="checkbox" name="enabled" <?= !empty($c['enabled']) ? 'checked' : '' ?>> Показывать чат на главной</label>
        <div class="set-grid" style="margin-top:10px;">
          <label class="wide">Приветствие мастера (первое сообщение)<textarea name="greeting" rows="2" maxlength="500" required><?= esc($c['greeting'] ?? '') ?></textarea></label>
        </div>
      </section>
      <section class="set-card">
        <h2>Быстрые кнопки (темы)</h2>
        <p class="set-hint">Кнопки под полем ввода. «Что уйдёт мастеру» — текст, который отправится при нажатии; пусто — отправится сама надпись. До 8 кнопок.</p>
        <div class="blk-rows" data-rows data-max="8">
          <?php foreach ($c['chips'] as $i => $chip): ?>
            <div class="blk-item" data-row>
              <input name="chips[<?= $i ?>][label]" value="<?= esc($chip['label']) ?>" maxlength="40" placeholder="Надпись" required>
              <input name="chips[<?= $i ?>][text]" value="<?= esc($chip['text'] ?? '') ?>" maxlength="300" placeholder="Что уйдёт мастеру (необязательно)" class="grow">
              <span class="blk-move"><button type="button" data-up>↑</button><button type="button" data-down>↓</button><button type="button" data-del title="Удалить">✕</button></span>
            </div>
          <?php endforeach; ?>
        </div>
        <button type="button" class="link-btn" data-add-row="chips" style="margin-top:8px;">+ добавить кнопку</button>
        <template data-row-template="chips">
          <div class="blk-item" data-row>
            <input name="chips[__i__][label]" maxlength="40" placeholder="Надпись" required>
            <input name="chips[__i__][text]" maxlength="300" placeholder="Что уйдёт мастеру (необязательно)" class="grow">
            <span class="blk-move"><button type="button" data-up>↑</button><button type="button" data-down>↓</button><button type="button" data-del title="Удалить">✕</button></span>
          </div>
        </template>
      </section>
      <section class="set-card">
        <h2>Кнопка «в каталог»</h2>
        <label class="f-check"><input type="checkbox" name="catalogButton" <?= !empty($c['catalogButton']) ? 'checked' : '' ?>> Показывать</label>
        <div class="set-grid" style="margin-top:8px;"><label>Надпись<input name="catalogButtonLabel" value="<?= esc($c['catalogButtonLabel'] ?? '') ?>" maxlength="40"></label></div>
      </section>
      <section class="set-card blk-soon">
        <h2>Настройки ИИ</h2>
        <p class="set-hint">Характер мастера, модель, подсказки и ограничения — будет отдельным разделом «Настройки ИИ». Пока они задаются в файлах консультанта на сервере.</p>
        <span class="btn btn-light" aria-disabled="true">Скоро</span>
      </section>
      <button class="btn" type="submit">Сохранить</button>
    </form>
    <?php
}

function blocksFormProductChat(array $c, array $state): void
{
    ?>
    <form method="post" action="?tab=blocks&b=productChat">
      <input type="hidden" name="action" value="save">
      <section class="set-card">
        <h2>Чат в карточке товара</h2>
        <p class="set-hint">Окно чата справа от цены на странице каждого чая. Мастер знает, на каком чае стоит покупатель, и отвечает про него. Диалог общий с главной: начал здесь — продолжил там; в «Диалогах» такие вопросы помечены «из карточки чая».</p>
        <label class="f-check"><input type="checkbox" name="enabled" <?= !empty($c['enabled']) ? 'checked' : '' ?>> Показывать на страницах чаёв</label>
        <div class="set-grid" style="margin-top:10px;">
          <label>Заголовок окна<input name="title" value="<?= esc($c['title'] ?? '') ?>" maxlength="60"></label>
          <label class="wide">Приветствие (<b>{чай}</b> заменится на название)<textarea name="greeting" rows="2" maxlength="500" required><?= esc($c['greeting'] ?? '') ?></textarea></label>
        </div>
      </section>
      <section class="set-card">
        <h2>Быстрые вопросы</h2>
        <p class="set-hint">Кнопки под приветствием, до 6. «Что уйдёт мастеру» — пусто: отправится сама надпись.</p>
        <div class="blk-rows" data-rows data-max="6">
          <?php foreach ($c['chips'] as $i => $chip): ?>
            <div class="blk-item" data-row>
              <input name="chips[<?= $i ?>][label]" value="<?= esc($chip['label']) ?>" maxlength="40" placeholder="Надпись" required>
              <input name="chips[<?= $i ?>][text]" value="<?= esc($chip['text'] ?? '') ?>" maxlength="300" placeholder="Что уйдёт мастеру (необязательно)" class="grow">
              <span class="blk-move"><button type="button" data-up>↑</button><button type="button" data-down>↓</button><button type="button" data-del title="Удалить">✕</button></span>
            </div>
          <?php endforeach; ?>
        </div>
        <button type="button" class="link-btn" data-add-row="chips" style="margin-top:8px;">+ добавить вопрос</button>
        <template data-row-template="chips">
          <div class="blk-item" data-row>
            <input name="chips[__i__][label]" maxlength="40" placeholder="Надпись" required>
            <input name="chips[__i__][text]" maxlength="300" placeholder="Что уйдёт мастеру (необязательно)" class="grow">
            <span class="blk-move"><button type="button" data-up>↑</button><button type="button" data-down>↓</button><button type="button" data-del title="Удалить">✕</button></span>
          </div>
        </template>
      </section>
      <button class="btn" type="submit">Сохранить</button>
    </form>
    <?php
}

function blocksFormShowcase(array $c, array $state): void
{
    $src = $c['source'] ?? 'featured';
    $picked = (array) ($c['teaIds'] ?? []);
    ?>
    <form method="post" action="?tab=blocks&b=showcase" data-showcase-form>
      <input type="hidden" name="action" value="save">
      <input type="hidden" name="teaOrder" value="<?= esc(implode(',', $picked)) ?>" data-tea-order>
      <section class="set-card">
        <h2>Первая витрина</h2>
        <label class="f-check"><input type="checkbox" name="enabled" <?= !empty($c['enabled']) ? 'checked' : '' ?>> Показывать на главной</label>
        <div class="set-grid" style="margin-top:10px;">
          <label>Заголовок<input name="title" value="<?= esc($c['title'] ?? '') ?>" maxlength="80" required></label>
          <label>Сколько чаёв показать<input name="limit" type="number" min="1" max="12" value="<?= (int) ($c['limit'] ?? 4) ?>"></label>
          <label class="wide">Описание<input name="description" value="<?= esc($c['description'] ?? '') ?>" maxlength="300"></label>
          <label class="wide f-check"><span><input type="checkbox" name="showAllCard" <?= !empty($c['showAllCard']) ? 'checked' : '' ?>> Плитка «Весь каталог» в конце ряда</span></label>
        </div>
      </section>
      <section class="set-card">
        <h2>Какие чаи</h2>
        <label class="blk-src"><input type="radio" name="source" value="featured" <?= $src === 'featured' ? 'checked' : '' ?>> <b>Популярные</b> — отмеченные «Показывать в „Популярных“» в карточке чая</label>
        <label class="blk-src"><input type="radio" name="source" value="category" <?= $src === 'category' ? 'checked' : '' ?>> <b>Категория</b> —
          <select name="categoryId">
            <option value="">выберите…</option>
            <?php foreach ($state['categories'] as $cat): ?>
              <option value="<?= esc($cat['id']) ?>" <?= ($c['categoryId'] ?? '') === $cat['id'] ? 'selected' : '' ?> <?= empty($cat['active']) ? 'disabled' : '' ?>><?= esc($cat['name']) ?> (<?= (int) $cat['count'] ?>)<?= empty($cat['active']) ? ' — выключена' : '' ?></option>
            <?php endforeach; ?>
          </select>
          <span class="set-hint">ссылки «Смотреть все» поведут на страницу категории</span>
        </label>
        <label class="blk-src"><input type="radio" name="source" value="manual" <?= $src === 'manual' ? 'checked' : '' ?>> <b>Вручную</b> — отметьте чаи ниже; порядок — как отмечали</label>
        <div class="cat-teas" data-manual style="margin-top:8px;">
          <?php foreach ($state['teas'] as $t): ?>
            <label class="cat-tea"><input type="checkbox" name="teaIds[]" value="<?= esc($t['id']) ?>" <?= in_array($t['id'], $picked, true) ? 'checked' : '' ?>> <?= esc($t['name'] ?? '') ?>
              <span class="set-hint"><?= esc($t['categoryLabel'] ?? '') ?></span>
              <?php $pos = array_search($t['id'], $picked, true); ?><b class="blk-pos" data-pos="<?= esc($t['id']) ?>"><?= $pos !== false ? '№' . ($pos + 1) : '' ?></b></label>
          <?php endforeach; ?>
        </div>
      </section>
      <button class="btn" type="submit">Сохранить</button>
    </form>
    <?php
}

function blocksFormGuild(array $c, array $state): void
{
    ?>
    <form method="post" action="?tab=blocks&b=guild">
      <input type="hidden" name="action" value="save">
      <section class="set-card"><h2>Чайная гильдия</h2>
        <label class="f-check"><input type="checkbox" name="enabled" <?= !empty($c['enabled']) ? 'checked' : '' ?>> Показывать баннер на главной</label>
      </section>
      <button class="btn" type="submit">Сохранить</button>
    </form>
    <?php
}

function blocksFormFooter(array $c, array $state): void
{
    $ct = $c['contacts'] ?? [];
    $so = $c['socials'] ?? [];
    ?>
    <form method="post" action="?tab=blocks&b=footer">
      <input type="hidden" name="action" value="save">
      <section class="set-card">
        <h2>Подвал</h2>
        <label class="f-check"><input type="checkbox" name="enabled" <?= !empty($c['enabled']) ? 'checked' : '' ?>> Показывать подвал (строка с политикой конфиденциальности остаётся всегда)</label>
      </section>
      <section class="set-card">
        <h2>Пункты</h2>
        <p class="set-hint">Порядок, заголовок, подпись, видимость. Первый «Чат с мастером» — тёмная кнопка-пилюля.</p>
        <div class="blk-rows" data-rows>
          <?php foreach ($c['nav'] as $i => $n): ?>
            <div class="blk-item" data-row>
              <input type="hidden" name="nav[<?= $i ?>][key]" value="<?= esc($n['key']) ?>">
              <label class="blk-on"><input type="checkbox" name="nav[<?= $i ?>][enabled]" <?= !empty($n['enabled']) ? 'checked' : '' ?>></label>
              <input name="nav[<?= $i ?>][title]" value="<?= esc($n['title']) ?>" maxlength="40" required>
              <input name="nav[<?= $i ?>][sub]" value="<?= esc($n['sub'] ?? '') ?>" maxlength="60" class="grow" placeholder="Подпись">
              <span class="blk-move"><button type="button" data-up>↑</button><button type="button" data-down>↓</button></span>
            </div>
          <?php endforeach; ?>
        </div>
      </section>
      <section class="set-card">
        <h2>Контакты</h2>
        <p class="set-hint">Пустое поле не показывается. Строка контактов идёт под пунктами подвала.</p>
        <div class="set-grid">
          <label>Адрес<input name="address" value="<?= esc($ct['address'] ?? '') ?>" maxlength="200" placeholder="Иркутск, Чудотворная, 2в"></label>
          <label>Ссылка на карту<input name="mapUrl" value="<?= esc($ct['mapUrl'] ?? '') ?>" maxlength="500" placeholder="https://yandex.ru/maps/…"></label>
          <label>Телефон<input name="phone" value="<?= esc($ct['phone'] ?? '') ?>" maxlength="40"></label>
          <label>Почта<input name="email" value="<?= esc($ct['email'] ?? '') ?>" maxlength="120"></label>
          <label class="wide">Часы работы<input name="hours" value="<?= esc($ct['hours'] ?? '') ?>" maxlength="120" placeholder="ежедневно 10:00–21:00"></label>
        </div>
      </section>
      <section class="set-card">
        <h2>Соцсети</h2>
        <p class="set-hint">Можно ссылкой или коротко: @имя для Telegram и ВКонтакте, номер для WhatsApp.</p>
        <div class="set-grid">
          <label>Telegram<input name="telegram" value="<?= esc($so['telegram'] ?? '') ?>" maxlength="200" placeholder="@gorodchaya"></label>
          <label>ВКонтакте<input name="vk" value="<?= esc($so['vk'] ?? '') ?>" maxlength="200"></label>
          <label>WhatsApp<input name="whatsapp" value="<?= esc($so['whatsapp'] ?? '') ?>" maxlength="200" placeholder="+7 …"></label>
        </div>
      </section>
      <section class="set-card">
        <h2>Юридическая строка</h2>
        <div class="set-grid">
          <label class="wide">Реквизиты (после имени продавца)<input name="requisites" value="<?= esc($c['requisites'] ?? '') ?>" maxlength="300" placeholder="ИНН …, ОГРНИП …"></label>
          <label class="wide">Копирайт (в начале строки)<input name="copyright" value="<?= esc($c['copyright'] ?? '') ?>" maxlength="200" placeholder="© 2026 Чайный город"></label>
        </div>
        <p class="set-hint">Имя продавца берётся из настроек сервера (то же, что в политике конфиденциальности).</p>
      </section>
      <button class="btn" type="submit">Сохранить</button>
    </form>
    <?php
}

function blocksScript(): string
{
    return <<<'JS'
<script>
(function () {
  // Перестановка строк ↑↓, удаление, добавление; индексы в name — по порядку.
  function renumber(box) {
    box.querySelectorAll('[data-row]').forEach(function (row, i) {
      row.querySelectorAll('[name]').forEach(function (el) { el.name = el.name.replace(/\[\d+\]/, '[' + i + ']'); });
    });
  }
  document.querySelectorAll('[data-rows]').forEach(function (box) {
    box.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var row = b.closest('[data-row]');
      if (b.hasAttribute('data-up') && row.previousElementSibling) box.insertBefore(row, row.previousElementSibling);
      else if (b.hasAttribute('data-down') && row.nextElementSibling) box.insertBefore(row.nextElementSibling, row);
      else if (b.hasAttribute('data-del')) row.remove();
      renumber(box);
    });
  });
  document.querySelectorAll('[data-add-row]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var name = btn.getAttribute('data-add-row');
      var tpl = document.querySelector('[data-row-template="' + name + '"]');
      var box = btn.parentElement.querySelector('[data-rows]');
      var max = Number(box.getAttribute('data-max') || 99);
      if (box.querySelectorAll('[data-row]').length >= max) { alert('Не больше ' + max); return; }
      box.insertAdjacentHTML('beforeend', tpl.innerHTML.replace(/__i__/g, '999'));
      renumber(box);
    });
  });
  // Витрина «вручную»: порядок — как отмечали.
  var form = document.querySelector('[data-showcase-form]');
  if (form) {
    var orderEl = form.querySelector('[data-tea-order]');
    var order = orderEl.value ? orderEl.value.split(',') : [];
    var paint = function () {
      form.querySelectorAll('[data-pos]').forEach(function (el) {
        var i = order.indexOf(el.getAttribute('data-pos'));
        el.textContent = i === -1 ? '' : '№' + (i + 1);
      });
      orderEl.value = order.join(',');
    };
    form.querySelectorAll('[data-manual] input[type=checkbox]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        order = order.filter(function (x) { return x !== cb.value; });
        if (cb.checked) { order.push(cb.value); form.querySelector('input[name=source][value=manual]').checked = true; }
        paint();
      });
    });
    form.querySelector('select[name=categoryId]').addEventListener('change', function () {
      form.querySelector('input[name=source][value=category]').checked = true;
    });
  }
})();
</script>
JS;
}

function blocksCss(): string
{
    return <<<'CSS'
<style>
  .blk-list { display: flex; flex-direction: column; gap: 8px; }
  .blk-row { display: flex; align-items: center; gap: 14px; background: var(--tea-paper); border: 1px solid var(--tea-border); border-radius: 12px; padding: 12px 16px; }
  .blk-row.off .blk-main { opacity: .55; }
  .blk-main { flex: 1; display: flex; flex-direction: column; gap: 2px; font-size: 14.5px; }
  .blk-main .set-hint { margin: 0; }
  .blk-row .btn { text-decoration: none; padding: 7px 14px; font-size: 13px; }
  .blk-gap { width: 98px; }
  .switch { width: 42px; height: 24px; border-radius: 999px; border: none; background: #d8d0bd; position: relative; cursor: pointer; padding: 0; }
  .switch span { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: left .15s; }
  .switch.on { background: var(--tea-green); }
  .switch.on span { left: 21px; }
  .blk-hist { list-style: none; padding: 0; margin: 0; font-size: 13.5px; }
  .blk-hist li { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px dashed var(--tea-border); }
  .blk-rows { display: flex; flex-direction: column; gap: 6px; }
  .blk-item { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .blk-item input:not([type=checkbox]) { border: 1px solid var(--tea-border); border-radius: 8px; padding: 6px 9px; font: inherit; font-size: 13.5px; min-width: 140px; }
  .blk-item .grow { flex: 1; min-width: 200px; }
  .blk-href { margin: 0; font-size: 11.5px; min-width: 150px; }
  .blk-move { display: inline-flex; gap: 4px; margin-left: auto; }
  .blk-move button { border: 1px solid var(--tea-border); background: #fff; border-radius: 6px; width: 28px; height: 28px; cursor: pointer; font-size: 13px; color: var(--tea-green-dark); }
  .blk-src { display: block; font-size: 13.5px; margin: 6px 0; }
  .blk-src select { border: 1px solid var(--tea-border); border-radius: 8px; padding: 5px 8px; font: inherit; font-size: 13px; }
  .blk-src .set-hint { display: block; margin: 2px 0 0 22px; }
  .blk-pos { color: var(--tea-green); font-size: 12px; }
  .blk-soon { background: #faf7ef; }
  .blk-soon .btn { opacity: .5; cursor: default; }
</style>
CSS;
}
