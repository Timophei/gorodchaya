<?php

declare(strict_types=1);

/**
 * Вкладка «Продукты»: список чаёв, редактор карточки (включая SEO и адрес
 * страницы), загрузка фото, QR с короткой ссылкой /t/<номер>, добавление и
 * удаление. Данные живут в бэкенде витрины (127.0.0.1:4000) — эта страница
 * только ходит в его API с ключом CHAYGOROD_API_KEY (см. ordersApiRequest()
 * в index.php). После каждой правки бэкенд сам перепекает страницы чаёв и
 * обновляет базу знаний мастера в чате.
 *
 * Подключается из index.php; адрес: ?tab=products, ?tab=products&id=<id>,
 * ?tab=products&new=1.
 */

const PRODUCT_CATEGORIES = [
    'oolong' => 'Улун',
    'black' => 'Чёрный (красный) чай',
    'green' => 'Зелёный чай',
    'white' => 'Белый чай',
    'yellow' => 'Жёлтый чай',
    'puer' => 'Пуэр',
    'herbal' => 'Травяной сбор',
    'teaware' => 'Посуда',
];

const PRODUCT_REGIONS = [
    'china' => 'Китай',
    'thailand' => 'Таиланд',
    'japan' => 'Япония',
    'india' => 'Индия',
    'russia' => 'Россия',
];

const PRODUCT_BREWING = [
    'gongfu_proliv' => 'Гунфу-пролив',
    'teapot_or_press' => 'Чайник / френч-пресс',
    'thermos' => 'Термос',
];

const PRODUCT_SITE_ORIGIN = 'https://gorodchaya.ru';

/** Сырые байты в API (фото). */
function productsApiRaw(string $path, string $contentType, string $body): array
{
    $apiKey = ordersApiKey();
    if ($apiKey === '') {
        return ['ok' => false, 'data' => null, 'error' => 'CHAYGOROD_API_KEY не задан в .env'];
    }
    $ctx = stream_context_create(['http' => [
        'method' => 'POST',
        'header' => "X-Api-Key: {$apiKey}\r\nAccept: application/json\r\nContent-Type: {$contentType}\r\n",
        'content' => $body,
        'timeout' => 20,
        'ignore_errors' => true,
    ]]);
    $raw = @file_get_contents(ORDERS_API_BASE . $path, false, $ctx);
    if ($raw === false) {
        return ['ok' => false, 'data' => null, 'error' => 'Бэкенд недоступен (127.0.0.1:4000)'];
    }
    $statusOk = (bool) preg_match('#\s(2\d\d)\s#', $http_response_header[0] ?? '');
    $decoded = json_decode($raw, true);
    return ['ok' => $statusOk, 'data' => $decoded, 'error' => $statusOk ? null : ($decoded['error'] ?? 'Ошибка запроса')];
}

/** Защита от подделки запроса с чужого сайта: POST принимаем только со своих страниц. */
function productsSameOrigin(): bool
{
    $src = $_SERVER['HTTP_ORIGIN'] ?? ($_SERVER['HTTP_REFERER'] ?? '');
    if ($src === '') {
        return true; // старые браузеры/закладки — Basic Auth всё равно уже пройден
    }
    $host = parse_url($src, PHP_URL_HOST);
    $own = parse_url('http://' . (string) ($_SERVER['HTTP_HOST'] ?? ''), PHP_URL_HOST); // без порта
    return is_string($host) && is_string($own) && strcasecmp($host, $own) === 0;
}

function productsLines(string $text): array
{
    $out = [];
    foreach (preg_split('/\r\n|\r|\n/', $text) ?: [] as $line) {
        $line = trim($line);
        if ($line !== '') {
            $out[] = $line;
        }
    }
    return $out;
}

/** Форма -> тело запроса POST /api/teas. */
function productsPayloadFromPost(array $p): array
{
    $prices = [];
    $weights = $p['price_weight'] ?? [];
    $amounts = $p['price_amount'] ?? [];
    $stocks = $p['price_stock'] ?? [];
    foreach ((array) $weights as $i => $w) {
        $w = trim((string) $w);
        $a = trim((string) ($amounts[$i] ?? ''));
        if ($w === '' && $a === '') {
            continue;
        }
        $st = trim((string) ($stocks[$i] ?? ''));
        $prices[] = [
            'weightGrams' => (int) preg_replace('/\D/', '', $w),
            'price' => (int) preg_replace('/\D/', '', $a),
            // Пусто — остаток не ведётся; минус допустим (продано «под заказ»).
            'stock' => preg_match('/^-?\d+$/', $st) ? (int) $st : null,
        ];
    }
    usort($prices, static fn ($x, $y) => $x['weightGrams'] <=> $y['weightGrams']);

    $brewing = [];
    foreach (PRODUCT_BREWING as $key => $_label) {
        $v = trim((string) ($p['brewing'][$key] ?? ''));
        if ($v !== '') {
            $brewing[$key] = $v;
        }
    }

    $category = (string) ($p['category'] ?? '');
    $region = (string) ($p['region'] ?? '');

    $payload = [
        'name' => trim((string) ($p['name'] ?? '')),
        'subtitle' => trim((string) ($p['subtitle'] ?? '')) ?: null,
        'externalId' => trim((string) ($p['externalId'] ?? '')) ?: null,
        'category' => $category,
        'categoryLabel' => PRODUCT_CATEGORIES[$category] ?? $category,
        'region' => $region !== '' ? $region : null,
        'regionLabel' => trim((string) ($p['regionLabel'] ?? '')) ?: null,
        'description' => trim((string) ($p['description'] ?? '')) ?: null,
        'shortDescription' => trim((string) ($p['shortDescription'] ?? '')) ?: null,
        'reviewNotes' => array_slice(productsLines((string) ($p['reviewNotes'] ?? '')), 0, 20),
        'taste' => productsLines((string) ($p['taste'] ?? '')),
        'tasteNote' => trim((string) ($p['tasteNote'] ?? '')) ?: null,
        'situations' => productsLines((string) ($p['situations'] ?? '')),
        'effectsNote' => trim((string) ($p['effectsNote'] ?? '')) ?: null,
        'liquorColor' => trim((string) ($p['liquorColor'] ?? '')) ?: null,
        'waterTemperature' => trim((string) ($p['waterTemperature'] ?? '')) ?: null,
        'vessels' => productsLines((string) ($p['vessels'] ?? '')),
        'contraindications' => productsLines((string) ($p['contraindications'] ?? '')),
        'cityOpinion' => trim((string) ($p['cityOpinion'] ?? '')) ?: null,
        'brewing' => (object) $brewing,
        'featured' => !empty($p['featured']),
        'sortOrder' => (int) ($p['sortOrder'] ?? 0),
        'prices' => $prices,
        'slug' => strtolower(trim((string) ($p['slug'] ?? ''))),
        'seoTitle' => trim((string) ($p['seoTitle'] ?? '')) ?: null,
        'seoDescription' => trim((string) ($p['seoDescription'] ?? '')) ?: null,
    ];
    $id = trim((string) ($p['id'] ?? ''));
    if ($id !== '') {
        $payload['id'] = $id;
    }
    return $payload;
}

/** Ошибки валидации бэкенда -> понятные строки. */
function productsErrorLines(array $result): array
{
    $labels = [
        'name' => 'Название', 'category' => 'Категория', 'externalId' => 'Номер', 'slug' => 'Адрес страницы',
        'seoTitle' => 'SEO-заголовок', 'seoDescription' => 'SEO-описание', 'prices' => 'Фасовки и цены',
        'description' => 'Описание', 'cityOpinion' => 'Мнение Города',
    ];
    $details = is_array($result['data']['details'] ?? null) ? $result['data']['details'] : [];
    if (!$details) {
        return [(string) ($result['error'] ?? 'Не удалось сохранить')];
    }
    $out = [];
    foreach ($details as $d) {
        $field = (string) (($d['path'] ?? [])[0] ?? '');
        $out[] = ($labels[$field] ?? $field ?: 'Поле') . ': ' . (string) ($d['message'] ?? 'ошибка');
    }
    return $out;
}

/**
 * Обработка запроса до вывода страницы (редиректы, JSON статуса).
 *
 * @return array{list: array, tea: ?array, isNew: bool, errors: array, flash: ?string, formOverride: ?array, apiError: ?string}
 */
function productsHandle(): array
{
    $state = ['list' => [], 'tea' => null, 'isNew' => false, 'errors' => [], 'flash' => null, 'formOverride' => null, 'apiError' => null];
    $id = isset($_GET['id']) && is_string($_GET['id']) && preg_match('/^[A-Za-z0-9_-]{1,100}$/', $_GET['id']) ? $_GET['id'] : null;

    if (isset($_GET['sync_status'])) {
        $r = ordersApiRequest('GET', '/admin/catalog-status');
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        echo json_encode($r['data'] ?? ['message' => $r['error']], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        if (!productsSameOrigin()) {
            http_response_code(403);
            exit('Запрос отклонён: отправлен не со страницы админки.');
        }
        $action = (string) ($_POST['action'] ?? '');

        if ($action === 'save') {
            $payload = productsPayloadFromPost($_POST);
            $result = ordersApiRequest('POST', '/teas', $payload);
            if ($result['ok'] && is_array($result['data'])) {
                header('Location: ?tab=products&id=' . rawurlencode((string) $result['data']['id']) . '&saved=1');
                exit;
            }
            $state['errors'] = productsErrorLines($result);
            $state['formOverride'] = $payload;
        } elseif ($action === 'delete' && $id !== null) {
            $result = ordersApiRequest('DELETE', '/teas/' . rawurlencode($id));
            if ($result['ok']) {
                header('Location: ?tab=products&deleted=1');
                exit;
            }
            $state['errors'] = productsErrorLines($result);
        } elseif ($action === 'photo' && $id !== null) {
            $f = $_FILES['photo'] ?? null;
            if (!is_array($f) || ($f['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
                $code = is_array($f) ? (int) $f['error'] : UPLOAD_ERR_NO_FILE;
                $state['errors'] = [$code === UPLOAD_ERR_INI_SIZE || $code === UPLOAD_ERR_FORM_SIZE
                    ? 'Файл слишком большой.'
                    : 'Файл не загрузился — выберите фото ещё раз.'];
            } else {
                $info = @getimagesize($f['tmp_name']);
                $mime = is_array($info) ? (string) ($info['mime'] ?? '') : '';
                if (!in_array($mime, ['image/jpeg', 'image/png', 'image/webp'], true)) {
                    $state['errors'] = ['Нужна картинка JPEG, PNG или WebP.'];
                } else {
                    $result = productsApiRaw('/admin/teas/' . rawurlencode($id) . '/photo', $mime, (string) file_get_contents($f['tmp_name']));
                    if ($result['ok']) {
                        header('Location: ?tab=products&id=' . rawurlencode($id) . '&photo=1');
                        exit;
                    }
                    $state['errors'] = ['Фото не сохранилось: ' . ($result['error'] ?? 'ошибка')];
                }
            }
        } elseif ($action === 'sync') {
            ordersApiRequest('POST', '/admin/catalog-sync', []);
            header('Location: ?tab=products&synced=1');
            exit;
        }
    }

    if (isset($_GET['saved'])) { $state['flash'] = 'Сохранено. Страница чая и знания мастера обновятся через пару секунд.'; }
    if (isset($_GET['photo'])) { $state['flash'] = 'Фото загружено.'; }
    if (isset($_GET['deleted'])) { $state['flash'] = 'Чай удалён. Его страница исчезнет с сайта, а старые ссылки поведут на «чай не найден».'; }
    if (isset($_GET['synced'])) { $state['flash'] = 'Запущено обновление страниц и знаний мастера.'; }

    if ($id !== null) {
        $r = ordersApiRequest('GET', '/teas/' . rawurlencode($id));
        if ($r['ok'] && is_array($r['data'])) {
            $state['tea'] = $r['data'];
        } else {
            $state['apiError'] = $r['error'] === 'not_found' ? 'Такого чая нет.' : ($r['error'] ?? 'Не удалось получить чай');
        }
    } elseif (isset($_GET['new'])) {
        $state['isNew'] = true;
    } else {
        $r = ordersApiRequest('GET', '/teas');
        if ($r['ok'] && is_array($r['data'])) {
            $state['list'] = $r['data'];
            usort($state['list'], static fn ($a, $b) => ((int) ($a['externalId'] ?? 0)) <=> ((int) ($b['externalId'] ?? 0)));
        } else {
            $state['apiError'] = $r['error'] ?? 'Не удалось получить каталог';
        }
    }
    return $state;
}

function productsShortUrl(array $t): string
{
    return PRODUCT_SITE_ORIGIN . '/t/' . rawurlencode((string) ($t['externalId'] ?? ''));
}

function productsPageUrl(array $t): string
{
    return PRODUCT_SITE_ORIGIN . '/tea/' . rawurlencode((string) ($t['slug'] ?? ''));
}

function productsAutoTitle(array $t): string
{
    $cat = mb_strtolower((string) (PRODUCT_CATEGORIES[$t['category'] ?? ''] ?? 'чай'));
    return trim((string) ($t['name'] ?? '')) . ' — купить ' . $cat . ' | Чайный город';
}

function productsImageSrc(array $t): ?string
{
    $u = (string) ($t['imageUrl'] ?? '');
    if ($u === '') {
        return null;
    }
    return preg_match('#^https?://#', $u) ? $u : '/' . ltrim($u, '/');
}

function productsRender(array $state): void
{
    if ($state['flash']): ?>
      <div class="flash"><?= esc($state['flash']) ?></div>
    <?php endif;
    if ($state['apiError']): ?>
      <div class="api-error"><?= esc($state['apiError']) ?></div>
    <?php endif;

    if ($state['tea'] !== null || $state['isNew']) {
        productsRenderForm($state);
        return;
    }
    if ($state['apiError']) {
        return;
    }
    ?>
    <div class="prod-toolbar">
      <a class="btn" href="?tab=products&new=1">+ Добавить чай</a>
      <form method="post" action="?tab=products" style="margin:0">
        <input type="hidden" name="action" value="sync">
        <button class="btn btn-ghost" type="submit" title="Перепечь страницы чаёв и обновить знания мастера">Обновить страницы сайта</button>
      </form>
      <span class="sync-status" data-sync-status></span>
    </div>
    <?php if (empty($state['list'])): ?>
      <div class="empty">Чаёв пока нет.</div>
    <?php endif; ?>
    <?php foreach ($state['list'] as $t): ?>
      <?php
        $img = productsImageSrc($t);
        $prices = is_array($t['prices'] ?? null) ? $t['prices'] : [];
      ?>
      <a class="prod-row" href="?tab=products&id=<?= esc(rawurlencode((string) $t['id'])) ?>">
        <span class="prod-thumb"<?= $img ? ' style="background-image:url(\'' . esc($img) . '\')"' : '' ?>><?= $img ? '' : 'нет фото' ?></span>
        <span class="prod-main">
          <span class="prod-name">№<?= esc($t['externalId'] ?? '—') ?> · <?= esc($t['name'] ?? '—') ?>
            <?php if (!empty($t['featured'])): ?><span class="badge">на главной</span><?php endif; ?>
            <?php if (!empty($t['reviewNotes'])): ?><span class="badge review-badge" title="<?= esc(implode(' ', (array) $t['reviewNotes'])) ?>">сверить</span><?php endif; ?>
          </span>
          <span class="prod-meta">
            /tea/<?= esc($t['slug'] ?? '—') ?>
            · <?= esc(PRODUCT_CATEGORIES[$t['category'] ?? ''] ?? ($t['category'] ?? '')) ?>
            <?= $prices ? '' : ' · <span class="warn">без цены</span>' ?>
          </span>
        </span>
        <span class="prod-stock">
          <?php foreach ($prices as $p): ?>
            <?php $st = $p['stock'] ?? null; $cls = $st === null ? 'none' : ($st > 0 ? 'in' : 'out'); ?>
            <span class="stock-line">
              <span class="w"><?= empty($p['weightGrams']) ? 'шт' : esc((string) $p['weightGrams']) . ' г' ?></span>
              <span class="pr"><?= number_format((int) ($p['price'] ?? 0), 0, '', ' ') ?> ₽</span>
              <span class="st <?= $cls ?>" title="<?= $st === null ? 'Остаток не ведётся — на сайте «Под заказ»' : ($st > 0 ? 'В наличии' : 'Под заказ') ?>"><?= $st === null ? '—' : esc((string) $st) . ' шт' ?></span>
            </span>
          <?php endforeach; ?>
        </span>
        <span class="prod-short">/t/<?= esc($t['externalId'] ?? '') ?></span>
      </a>
    <?php endforeach;
}

function productsRenderForm(array $state): void
{
    $isNew = $state['isNew'];
    $t = $state['formOverride'] ?? $state['tea'] ?? [];
    if ($state['formOverride'] !== null && $state['tea'] !== null) {
        $t = array_merge($state['tea'], $state['formOverride']);
    }
    $t = json_decode((string) json_encode($t), true) ?: []; // brewing (object) -> array
    $saved = $state['tea'] ?? [];
    $id = (string) ($saved['id'] ?? ($t['id'] ?? ''));
    $prices = is_array($t['prices'] ?? null) && $t['prices'] ? $t['prices'] : [['weightGrams' => '', 'price' => '', 'stock' => null]];
    $prices[] = ['weightGrams' => '', 'price' => '', 'stock' => null];
    $brewing = is_array($t['brewing'] ?? null) ? $t['brewing'] : [];
    $join = static fn ($v) => is_array($v) ? implode("\n", $v) : (string) ($v ?? '');
    $img = $saved ? productsImageSrc($saved) : null;
    ?>
    <a class="back-link" href="?tab=products">← ко всем чаям</a>

    <?php if ($state['errors']): ?>
      <div class="api-error"><b>Не сохранено.</b><br><?= implode('<br>', array_map('esc', $state['errors'])) ?></div>
    <?php endif; ?>

    <div class="prod-head">
      <h2><?= $isNew ? 'Новый чай' : esc($saved['name'] ?? '') ?></h2>
      <?php if (!$isNew && $saved): ?>
        <a class="ext" href="<?= esc(productsPageUrl($saved)) ?>" target="_blank" rel="noopener">открыть на сайте ↗</a>
        <span class="sync-status" data-sync-status></span>
      <?php endif; ?>
    </div>

    <form method="post" class="prod-form" action="?tab=products<?= $isNew ? '&new=1' : '&id=' . esc(rawurlencode($id)) ?>">
      <input type="hidden" name="action" value="save">
      <input type="hidden" name="id" value="<?= esc($isNew ? '' : $id) ?>">

      <section class="card-block">
        <h3>Основное</h3>
        <label class="f">Название*<input type="text" name="name" required maxlength="200" value="<?= esc($t['name'] ?? '') ?>" data-name></label>
        <label class="f">Подзаголовок<input type="text" name="subtitle" maxlength="300" value="<?= esc($t['subtitle'] ?? '') ?>" placeholder="Большой красный халат · тёмный уишаньский улун"></label>
        <div class="f-row">
          <label class="f">Категория*
            <select name="category" required data-category>
              <?php foreach (PRODUCT_CATEGORIES as $val => $label): ?>
                <option value="<?= esc($val) ?>" <?= ($t['category'] ?? '') === $val ? 'selected' : '' ?>><?= esc($label) ?></option>
              <?php endforeach; ?>
            </select>
          </label>
          <label class="f">Страна
            <select name="region">
              <option value="">—</option>
              <?php foreach (PRODUCT_REGIONS as $val => $label): ?>
                <option value="<?= esc($val) ?>" <?= ($t['region'] ?? '') === $val ? 'selected' : '' ?>><?= esc($label) ?></option>
              <?php endforeach; ?>
            </select>
          </label>
          <label class="f">Номер
            <input type="text" name="externalId" inputmode="numeric" pattern="\d{1,9}" maxlength="9" value="<?= esc($t['externalId'] ?? '') ?>" placeholder="авто">
          </label>
        </div>
        <label class="f">Регион подробно<input type="text" name="regionLabel" maxlength="200" value="<?= esc($t['regionLabel'] ?? '') ?>" placeholder="Уишань, провинция Фуцзянь, Китай"></label>
        <div class="f-row">
          <label class="f f-check"><input type="checkbox" name="featured" value="1" <?= !empty($t['featured']) ? 'checked' : '' ?>> Показывать в «Популярных» на главной</label>
          <label class="f">Порядок в каталоге<input type="number" name="sortOrder" value="<?= esc((string) ($t['sortOrder'] ?? 0)) ?>" style="max-width:110px"></label>
        </div>
        <div class="hint">Номер — это короткая ссылка /t/<?= esc((string) ($t['externalId'] ?? 'N')) ?>, «ID на сайте» для Битрикса (например <?= esc((string) ($t['externalId'] ?? '110')) ?>-50) и номер, которым мастер в чате ссылается на чай.</div>
      </section>

      <section class="card-block">
        <h3>Фасовки и цены</h3>
        <div class="prices" data-prices>
          <?php foreach ($prices as $p): ?>
            <div class="price-row">
              <input type="text" name="price_weight[]" inputmode="numeric" placeholder="граммы" title="Для посуды оставьте 0 — продаётся поштучно" value="<?= esc((string) ($p['weightGrams'] ?? '')) ?>"> г —
              <input type="text" name="price_amount[]" inputmode="numeric" placeholder="цена" value="<?= esc((string) ($p['price'] ?? '')) ?>"> ₽
              <span class="price-sep">остаток</span>
              <input type="text" name="price_stock[]" inputmode="numeric" placeholder="—" value="<?= esc(isset($p['stock']) && $p['stock'] !== null ? (string) $p['stock'] : '') ?>" class="stock-input"> шт
            </div>
          <?php endforeach; ?>
        </div>
        <button class="btn btn-ghost" type="button" data-add-price>+ фасовка</button>
        <div class="hint">Пустые строки не сохраняются. Остаток — в пачках этой фасовки: больше нуля — на сайте «В наличии», ноль, минус или пусто — «Под заказ»; купить можно всегда. Списывается сам, когда заказ переводят в «Отправлен». Каждая фасовка — отдельный товар в Битриксе с «ID на сайте» вида номер-граммы. Посуда: граммы 0, одна строка — цена и остаток в штуках.</div>
      </section>

      <section class="card-block">
        <h3>Описание и вкус</h3>
        <?php if (!empty($t['reviewNotes'])): ?>
          <div class="review-box"><b>Сверить по этикетке/у поставщика:</b><ul><?php foreach ((array) $t['reviewNotes'] as $n): ?><li><?= esc($n) ?></li><?php endforeach; ?></ul></div>
        <?php endif; ?>
        <label class="f">Коротко <span class="muted">— одна фраза: для поисковиков и превью ссылок</span><textarea name="shortDescription" rows="2" maxlength="500"><?= esc($t['shortDescription'] ?? '') ?></textarea></label>
        <label class="f">Описание<textarea name="description" rows="6" maxlength="5000"><?= esc($t['description'] ?? '') ?></textarea></label>
        <label class="f">Что сверить <span class="muted">— видно только в админке, по строке; проверили — сотрите</span><textarea name="reviewNotes" rows="3" maxlength="4000"><?= esc(implode("\n", (array) ($t['reviewNotes'] ?? []))) ?></textarea></label>
        <div class="f-row">
          <label class="f">Вкус и аромат <span class="muted">— по строке</span><textarea name="taste" rows="5"><?= esc($join($t['taste'] ?? [])) ?></textarea></label>
          <label class="f">Когда пить <span class="muted">— по строке</span><textarea name="situations" rows="5"><?= esc($join($t['situations'] ?? [])) ?></textarea></label>
        </div>
        <label class="f">Заметка о вкусе<input type="text" name="tasteNote" maxlength="1000" value="<?= esc($t['tasteNote'] ?? '') ?>"></label>
        <label class="f">Ощущения<textarea name="effectsNote" rows="2" maxlength="1000"><?= esc($t['effectsNote'] ?? '') ?></textarea></label>
        <div class="f-row">
          <label class="f">Цвет настоя<input type="text" name="liquorColor" maxlength="200" value="<?= esc($t['liquorColor'] ?? '') ?>"></label>
          <label class="f">Температура воды<input type="text" name="waterTemperature" maxlength="50" value="<?= esc($t['waterTemperature'] ?? '') ?>" placeholder="85–90 °C"></label>
        </div>
        <div class="f-row">
          <label class="f">Посуда <span class="muted">— по строке</span><textarea name="vessels" rows="3"><?= esc($join($t['vessels'] ?? [])) ?></textarea></label>
          <label class="f">Противопоказания <span class="muted">— по строке</span><textarea name="contraindications" rows="3"><?= esc($join($t['contraindications'] ?? [])) ?></textarea></label>
        </div>
      </section>

      <section class="card-block">
        <h3>Заваривание</h3>
        <?php foreach (PRODUCT_BREWING as $key => $label): ?>
          <label class="f"><?= esc($label) ?><textarea name="brewing[<?= esc($key) ?>]" rows="3" maxlength="2000"><?= esc($brewing[$key] ?? '') ?></textarea></label>
        <?php endforeach; ?>
      </section>

      <section class="card-block">
        <h3>Мнение Города</h3>
        <label class="f"><textarea name="cityOpinion" rows="6" maxlength="3000"><?= esc($t['cityOpinion'] ?? '') ?></textarea></label>
      </section>

      <section class="card-block">
        <h3>SEO и адрес страницы</h3>
        <label class="f">Адрес страницы
          <span class="slug-input"><span><?= esc(PRODUCT_SITE_ORIGIN) ?>/tea/</span><input type="text" name="slug" maxlength="80" pattern="[a-z0-9]+(-[a-z0-9]+)*" value="<?= esc($t['slug'] ?? '') ?>" placeholder="придумается из названия" data-slug></span>
        </label>
        <div class="hint">Латиница в нижнем регистре, цифры и дефисы. Если поменять адрес, старый продолжит работать и будет перенаправлять на новый.</div>
        <label class="f">Заголовок для поисковиков <span class="counter" data-count-for="seoTitle" data-max="60"></span>
          <input type="text" name="seoTitle" maxlength="120" value="<?= esc($t['seoTitle'] ?? '') ?>" placeholder="<?= esc(productsAutoTitle($t)) ?>" data-seo-title>
        </label>
        <label class="f">Описание для поисковиков <span class="counter" data-count-for="seoDescription" data-max="155"></span>
          <textarea name="seoDescription" rows="3" maxlength="300" placeholder="Пусто — возьмётся начало описания" data-seo-desc><?= esc($t['seoDescription'] ?? '') ?></textarea>
        </label>
        <div class="hint">Пустые поля заполняются автоматически. Оптимально: заголовок до 60 знаков, описание 120–155.</div>
        <div class="serp" data-serp>
          <div class="serp-url"></div>
          <div class="serp-title"></div>
          <div class="serp-desc"></div>
        </div>
      </section>

      <div class="form-actions">
        <button class="btn btn-big" type="submit"><?= $isNew ? 'Создать чай' : 'Сохранить' ?></button>
        <a class="back-link" href="?tab=products">Отмена</a>
      </div>
    </form>

    <?php if (!$isNew && $saved): ?>
    <div class="prod-bottom">
      <section class="card-block photo-block">
        <div class="photo-thumb"<?= $img ? ' style="background-image:url(\'' . esc($img) . '\')"' : '' ?>><?= $img ? '' : 'нет фото' ?></div>
        <form method="post" enctype="multipart/form-data" action="?tab=products&id=<?= esc(rawurlencode($id)) ?>" data-photo-form>
          <h3>Фото</h3>
          <input type="hidden" name="action" value="photo">
          <input type="file" name="photo" accept="image/jpeg,image/png,image/webp" required>
          <div class="hint">Лучше квадратное. Большие фото ужимаются до 1600 px прямо в браузере.</div>
          <button class="btn btn-ghost" type="submit">Загрузить фото</button>
        </form>
      </section>

      <section class="card-block qr-block" title="Короткая ссылка не меняется, даже если поменять адрес страницы. Номер меняйте, только если QR ещё нигде не напечатан.">
        <div class="qr-box" data-qr="<?= esc(productsShortUrl($saved)) ?>"></div>
        <div class="qr-info">
          <a class="qr-link" href="<?= esc(productsShortUrl($saved)) ?>" target="_blank" rel="noopener"><?= esc(preg_replace('#^https?://#', '', productsShortUrl($saved))) ?></a>
          <div class="qr-actions">
            <a href="#" data-copy="<?= esc(productsShortUrl($saved)) ?>">копировать</a>
            <a href="#" data-qr-png="qr-<?= esc((string) ($saved['externalId'] ?? '')) ?>-<?= esc((string) ($saved['slug'] ?? '')) ?>.png">PNG</a>
            <a href="#" data-qr-svg="qr-<?= esc((string) ($saved['externalId'] ?? '')) ?>-<?= esc((string) ($saved['slug'] ?? '')) ?>.svg">SVG</a>
          </div>
        </div>
      </section>
    </div>
    <?php endif; ?>

    <?php if (!$isNew && $saved): ?>
      <form method="post" class="danger-zone" action="?tab=products&id=<?= esc(rawurlencode($id)) ?>" onsubmit="return confirm('Удалить «<?= esc(addslashes((string) ($saved['name'] ?? ''))) ?>»? Страница исчезнет с сайта, мастер перестанет его советовать. Отменить нельзя.');">
        <input type="hidden" name="action" value="delete">
        <button class="btn btn-danger" type="submit">Удалить чай</button>
        <span class="hint">Заказы с этим чаем останутся в истории.</span>
      </form>
    <?php endif; ?>
    <?php
}

function productsCss(): string
{
    return <<<'CSS'
  /* --- продукты --- */
  .flash { background: #e6efe3; color: var(--tea-green-dark); border-radius: 10px; padding: 12px 16px; margin-bottom: 16px; font-size: 13.5px; }
  .prod-toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
  .btn { display: inline-block; text-decoration: none; }
  .btn-ghost { background: transparent; color: var(--tea-green-dark); border: 1px solid var(--tea-border); }
  .btn-ghost:hover { border-color: var(--tea-green); }
  .btn-danger { background: transparent; color: var(--tea-accent); border: 1px solid #e3b8ae; }
  .btn-big { padding: 12px 26px; font-size: 15px; }
  .sync-status { font-size: 12.5px; color: var(--tea-muted); }
  .sync-status.err { color: var(--tea-accent); }
  .prod-row { display: flex; align-items: center; gap: 14px; text-decoration: none; color: inherit; background: var(--tea-paper); border: 1px solid var(--tea-border); border-radius: 12px; padding: 10px 14px; margin-bottom: 8px; }
  .prod-row:hover { border-color: var(--tea-green); }
  .prod-thumb { width: 56px; height: 56px; border-radius: 10px; background: var(--tea-bot-bubble) center/cover no-repeat; flex-shrink: 0; font-size: 10px; color: var(--tea-muted); display: flex; align-items: center; justify-content: center; text-align: center; }
  .prod-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .prod-name { font-weight: 600; font-size: 15px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .prod-meta { font-size: 12.5px; color: var(--tea-muted); }
  .prod-meta .warn { color: var(--tea-accent); }
  .prod-stock { display: flex; flex-direction: column; gap: 3px; align-items: flex-end; flex-shrink: 0; }
  .stock-line { display: flex; gap: 10px; font-size: 12.5px; align-items: baseline; }
  .stock-line .w { color: var(--tea-muted); min-width: 40px; text-align: right; }
  .stock-line .pr { min-width: 64px; text-align: right; }
  .stock-line .st { min-width: 58px; text-align: right; font-weight: 700; padding: 1px 8px; border-radius: 999px; }
  .stock-line .st.in { background: #dcefdd; color: var(--tea-green-dark); }
  .stock-line .st.out { background: var(--tea-error-bg); color: var(--tea-accent); }
  .stock-line .st.none { color: var(--tea-muted); font-weight: 400; }
  .price-sep { color: var(--tea-muted); margin-left: 10px; }
  .price-row input.stock-input { max-width: 80px; }
  .prod-short { font-size: 12.5px; color: var(--tea-muted); font-family: ui-monospace, Menlo, monospace; }
  .prod-head { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 14px; }
  .prod-head h2 { margin: 0; font-size: 22px; }
  .prod-head .ext { font-size: 13px; color: var(--tea-green-dark); }
  .prod-bottom { display: flex; gap: 12px; align-items: stretch; margin-bottom: 12px; }
  .prod-bottom .card-block { margin-bottom: 0; }
  .card-block { background: var(--tea-paper); border: 1px solid var(--tea-border); border-radius: 12px; padding: 16px 18px; margin-bottom: 12px; }
  .card-block h3 { margin: 0 0 12px; font-size: 15px; }
  .f { display: flex; flex-direction: column; gap: 5px; font-size: 13px; font-weight: 600; color: var(--tea-text); margin-bottom: 12px; flex: 1; min-width: 0; }
  .f .muted { font-weight: 400; color: var(--tea-muted); }
  .f input[type=text], .f input[type=number], .f select, .f textarea, .price-row input {
    font: inherit; font-weight: 400; font-size: 14px; padding: 8px 10px; border: 1px solid var(--tea-border); border-radius: 8px; background: #fff; color: var(--tea-text); width: 100%; box-sizing: border-box;
  }
  .f textarea { resize: vertical; line-height: 1.45; }
  .f-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; }
  .f-check { flex-direction: row; align-items: center; font-weight: 400; gap: 8px; }
  .price-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 13.5px; }
  .price-row input { max-width: 120px; }
  .review-badge { background: #fdf1cf !important; color: #8a6a12 !important; }
  .review-box { background: #fff8e3; border: 1px solid #f0dca0; border-radius: 10px; padding: 10px 14px; margin-bottom: 12px; font-size: 13px; line-height: 1.5; }
  .review-box ul { margin: 4px 0 0; padding-left: 18px; }
  .hint { font-size: 12px; color: var(--tea-muted); line-height: 1.5; margin: 4px 0 8px; }
  .slug-input { display: flex; align-items: center; border: 1px solid var(--tea-border); border-radius: 8px; background: #fff; overflow: hidden; }
  .slug-input span { padding: 8px 0 8px 10px; color: var(--tea-muted); font-weight: 400; font-size: 13px; white-space: nowrap; }
  .slug-input input { border: none !important; padding-left: 2px !important; }
  .counter { font-weight: 400; color: var(--tea-muted); font-size: 12px; }
  .counter.over { color: var(--tea-accent); }
  .serp { border: 1px dashed var(--tea-border); border-radius: 10px; padding: 12px 14px; font-family: Arial, sans-serif; background: #fff; }
  .serp-url { font-size: 12.5px; color: #3c7a4f; margin-bottom: 3px; word-break: break-all; }
  .serp-title { font-size: 17px; color: #1a0dab; margin-bottom: 4px; }
  .serp-desc { font-size: 13px; color: #4d5156; line-height: 1.45; }
  .photo-block { flex: 1; display: flex; gap: 16px; align-items: flex-start; }
  .photo-block h3 { margin-bottom: 8px; }
  .photo-block input[type=file] { font-size: 13px; }
  .photo-thumb { width: 120px; height: 120px; border-radius: 10px; flex-shrink: 0; background: var(--tea-bot-bubble) center/cover no-repeat; display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--tea-muted); }
  .qr-block { flex: 0 0 auto; display: flex; gap: 12px; align-items: center; padding: 12px 14px; }
  .qr-box { width: 84px; height: 84px; display: flex; align-items: center; justify-content: center; font-size: 10px; color: var(--tea-muted); text-align: center; }
  .qr-box canvas { width: 84px; height: 84px; image-rendering: pixelated; }
  .qr-info { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; }
  .qr-link { font-family: ui-monospace, Menlo, monospace; color: var(--tea-green-dark); }
  .qr-actions { display: flex; gap: 10px; }
  .qr-actions a { color: var(--tea-muted); }
  .qr-actions a:hover { color: var(--tea-green-dark); }
  .form-actions { display: flex; align-items: center; gap: 16px; margin: 6px 0 24px; position: sticky; bottom: 0; background: var(--tea-cream); padding: 10px 0; }
  .danger-zone { display: flex; align-items: center; gap: 12px; border-top: 1px solid var(--tea-border); padding-top: 18px; }
  @media (max-width: 720px) { .prod-bottom { flex-direction: column; } .prod-short { display: none; } }
CSS;
}

function productsScript(): string
{
    $origin = json_encode(PRODUCT_SITE_ORIGIN);
    return <<<JS
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script>
<script>
(function () {
  var ORIGIN = {$origin};

  // --- QR короткой ссылки ---
  var box = document.querySelector('[data-qr]');
  var qr = null;
  if (box) {
    if (typeof qrcode !== 'function') {
      box.textContent = 'QR не загрузился';
    } else {
      qr = qrcode(0, 'M');
      qr.addData(box.getAttribute('data-qr'));
      qr.make();
      box.appendChild(qrCanvas(qr, 8, 4));
    }
  }
  function qrCanvas(q, cell, margin) {
    var n = q.getModuleCount(), size = (n + margin * 2) * cell;
    var c = document.createElement('canvas');
    c.width = size; c.height = size;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (var r = 0; r < n; r++) for (var col = 0; col < n; col++) {
      if (q.isDark(r, col)) ctx.fillRect((col + margin) * cell, (r + margin) * cell, cell, cell);
    }
    return c;
  }
  function download(name, href) {
    var a = document.createElement('a'); a.href = href; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }
  document.querySelectorAll('[data-qr-png]').forEach(function (b) {
    b.addEventListener('click', function (e) { e.preventDefault(); if (qr) download(b.getAttribute('data-qr-png'), qrCanvas(qr, 24, 4).toDataURL('image/png')); });
  });
  document.querySelectorAll('[data-qr-svg]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.preventDefault();
      if (!qr) return;
      var svg = qr.createSvgTag({ cellSize: 10, margin: 4, scalable: true });
      download(b.getAttribute('data-qr-svg'), URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })));
    });
  });
  document.querySelectorAll('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.preventDefault();
      var t = b.getAttribute('data-copy');
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () {
        b.textContent = 'скопировано'; setTimeout(function () { b.textContent = 'копировать'; }, 1500);
      }, function () { window.prompt('Скопируйте ссылку:', t); });
    });
  });

  // --- ещё одна строка фасовки ---
  var addPrice = document.querySelector('[data-add-price]');
  if (addPrice) addPrice.addEventListener('click', function () {
    var wrap = document.querySelector('[data-prices]');
    var row = wrap.querySelector('.price-row').cloneNode(true);
    row.querySelectorAll('input').forEach(function (i) { i.value = ''; });
    wrap.appendChild(row);
    row.querySelector('input').focus();
  });

  // --- счётчики и предпросмотр сниппета в поиске ---
  var form = document.querySelector('.prod-form');
  function val(sel) { var el = form && form.querySelector(sel); return el ? el.value.trim() : ''; }
  function updateSeo() {
    if (!form) return;
    document.querySelectorAll('[data-count-for]').forEach(function (c) {
      var el = form.querySelector('[name="' + c.getAttribute('data-count-for') + '"]');
      var max = +c.getAttribute('data-max'), len = (el.value || '').length;
      c.textContent = len ? len + ' / ' + max : '';
      c.classList.toggle('over', len > max);
    });
    var serp = document.querySelector('[data-serp]');
    if (!serp) return;
    var title = val('[data-seo-title]') || (form.querySelector('[data-seo-title]').placeholder || '');
    var desc = val('[data-seo-desc]') || val('[name="description"]') || val('[name="subtitle"]');
    if (desc.length > 155) desc = desc.slice(0, 155).replace(/\\s+\\S*$/, '') + '…';
    serp.querySelector('.serp-url').textContent = ORIGIN.replace(/^https?:\\/\\//, '') + ' › tea › ' + (val('[data-slug]') || '…');
    serp.querySelector('.serp-title').textContent = title.length > 65 ? title.slice(0, 64) + '…' : title;
    serp.querySelector('.serp-desc').textContent = desc || 'Описание появится, когда заполните описание чая.';
  }
  if (form) { form.addEventListener('input', updateSeo); updateSeo(); }

  // --- фото: ужимаем в браузере до 1600 px, чтобы не упираться в лимиты ---
  var pf = document.querySelector('[data-photo-form]');
  if (pf) pf.addEventListener('submit', function (e) {
    var input = pf.querySelector('input[type=file]');
    var file = input.files && input.files[0];
    if (!file || !window.createImageBitmap || !window.DataTransfer) return;
    e.preventDefault();
    var btn = pf.querySelector('button'); btn.disabled = true; btn.textContent = 'Готовим фото…';
    createImageBitmap(file).then(function (bmp) {
      var max = 1600, k = Math.min(1, max / Math.max(bmp.width, bmp.height));
      var c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      c.toBlob(function (blob) {
        var dt = new DataTransfer();
        dt.items.add(new File([blob], 'photo.jpg', { type: 'image/jpeg' }));
        input.files = dt.files;
        btn.textContent = 'Загружаем…';
        pf.submit();
      }, 'image/jpeg', 0.86);
    }).catch(function () { btn.disabled = false; btn.textContent = 'Загрузить фото'; pf.submit(); });
  });

  // --- статус перепечки страниц ---
  var st = document.querySelector('[data-sync-status]');
  function poll(n) {
    fetch('?tab=products&sync_status=1', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (s) {
      if (!st) return;
      if (s.running && n < 20) { st.textContent = 'Обновляем страницы…'; setTimeout(function () { poll(n + 1); }, 1000); return; }
      var when = s.lastRunAt ? new Date(s.lastRunAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
      st.textContent = s.ok === false ? 'Ошибка обновления страниц: ' + s.message : (when ? 'Страницы сайта обновлены в ' + when : '');
      st.classList.toggle('err', s.ok === false);
    }).catch(function () {});
  }
  if (st) setTimeout(function () { poll(0); }, /saved|photo|synced/.test(location.search) ? 1500 : 0);
})();
</script>
JS;
}
