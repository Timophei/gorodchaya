<?php

declare(strict_types=1);

/**
 * Вкладка «Категории» (?tab=categories, ?tab=categories&id=<id>, &new=1).
 * Категория — раздел витрины: вид чая («Зелёный чай») или подборка
 * («Коллекция НГ 2027»). Название, описание, картинка-превью, SEO,
 * активность, порядок и список чаёв. Чай может входить в несколько
 * категорий; основная задаётся в карточке чая. Данные — в бэкенде.
 * Страница категории на сайте: /catalog/<адрес>.
 */

/** @return array{list: array, cat: ?array, teas: array, isNew: bool, errors: array, flash: ?string, apiError: ?string, form: ?array} */
function categoriesHandle(): array
{
    $state = ['list' => [], 'cat' => null, 'teas' => [], 'isNew' => false, 'errors' => [], 'flash' => null, 'apiError' => null, 'form' => null];
    $id = isset($_GET['id']) && is_string($_GET['id']) && preg_match('/^[a-z0-9-]{1,60}$/', $_GET['id']) ? $_GET['id'] : null;

    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        if (!productsSameOrigin()) {
            http_response_code(403);
            exit('Запрос отклонён: отправлен не со страницы админки.');
        }
        $action = (string) ($_POST['action'] ?? '');
        $p = $_POST;
        if ($action === 'save') {
            $body = [
                'name' => trim((string) ($p['name'] ?? '')),
                'description' => trim((string) ($p['description'] ?? '')),
                'seoTitle' => trim((string) ($p['seoTitle'] ?? '')) ?: null,
                'seoDescription' => trim((string) ($p['seoDescription'] ?? '')) ?: null,
                'seoText' => trim((string) ($p['seoText'] ?? '')),
                'active' => isset($p['active']),
                'sortOrder' => (int) ($p['sortOrder'] ?? 0),
                'teaIds' => array_values(array_map('strval', (array) ($p['teaIds'] ?? []))),
            ];
            $newId = trim((string) ($p['id'] ?? ''));
            if ($id !== null) {
                $body['id'] = $id;
            } elseif ($newId !== '') {
                $body['id'] = $newId;
            }
            $r = ordersApiRequest('POST', '/admin/categories', $body);
            if ($r['ok'] && is_array($r['data'])) {
                $warn = isset($r['data']['warning']) ? '&warn=' . rawurlencode((string) $r['data']['warning']) : '';
                header('Location: ?tab=categories&id=' . rawurlencode((string) $r['data']['id']) . '&saved=1' . $warn);
                exit;
            }
            $state['errors'] = settingsErrors($r);
            $state['form'] = $body;
        } elseif ($action === 'delete' && $id !== null) {
            $r = ordersApiRequest('DELETE', '/admin/categories/' . rawurlencode($id));
            if ($r['ok']) {
                header('Location: ?tab=categories&deleted=1');
                exit;
            }
            $state['errors'] = [(string) ($r['data']['message'] ?? $r['error'] ?? 'Не удалось удалить')];
        } elseif ($action === 'photo' && $id !== null) {
            $f = $_FILES['photo'] ?? null;
            if (!is_array($f) || ($f['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
                $state['errors'] = ['Файл не загрузился — выберите картинку ещё раз.'];
            } else {
                $info = @getimagesize($f['tmp_name']);
                $mime = is_array($info) ? (string) ($info['mime'] ?? '') : '';
                if (!in_array($mime, ['image/jpeg', 'image/png', 'image/webp'], true)) {
                    $state['errors'] = ['Нужна картинка JPEG, PNG или WebP.'];
                } else {
                    $r = productsApiRaw('/admin/categories/' . rawurlencode($id) . '/photo', $mime, (string) file_get_contents($f['tmp_name']));
                    if ($r['ok']) {
                        header('Location: ?tab=categories&id=' . rawurlencode($id) . '&photo=1');
                        exit;
                    }
                    $state['errors'] = ['Картинка не сохранилась: ' . ($r['error'] ?? 'ошибка')];
                }
            }
        }
    }

    if (isset($_GET['saved'])) { $state['flash'] = 'Сохранено. Страница категории на сайте обновится через пару секунд.'; }
    if (isset($_GET['photo'])) { $state['flash'] = 'Картинка загружена.'; }
    if (isset($_GET['deleted'])) { $state['flash'] = 'Категория удалена.'; }
    if (isset($_GET['warn']) && is_string($_GET['warn'])) { $state['errors'][] = mb_substr($_GET['warn'], 0, 500); }

    $all = ordersApiRequest('GET', '/categories');
    if (!$all['ok'] || !is_array($all['data'])) {
        $state['apiError'] = $all['error'] ?? 'Не удалось получить категории';
        return $state;
    }
    $state['list'] = $all['data'];
    if ($id !== null || isset($_GET['new'])) {
        $teas = ordersApiRequest('GET', '/teas');
        $state['teas'] = $teas['ok'] && is_array($teas['data']) ? $teas['data'] : [];
        usort($state['teas'], static fn ($a, $b) => strcmp((string) ($a['name'] ?? ''), (string) ($b['name'] ?? '')));
    }
    if ($id !== null) {
        foreach ($state['list'] as $c) {
            if (($c['id'] ?? '') === $id) { $state['cat'] = $c; }
        }
        if ($state['cat'] === null) { $state['apiError'] = 'Такой категории нет.'; }
    } elseif (isset($_GET['new'])) {
        $state['isNew'] = true;
    }
    return $state;
}

function categoriesRender(array $state): void
{
    if ($state['flash']) { echo '<div class="flash">' . esc($state['flash']) . '</div>'; }
    foreach ($state['errors'] as $e) { echo '<div class="api-error">' . esc($e) . '</div>'; }
    if ($state['apiError']) {
        echo '<div class="api-error">' . esc($state['apiError']) . '</div><a class="back-link" href="?tab=categories">← все категории</a>';
        return;
    }
    if ($state['cat'] !== null || $state['isNew']) {
        categoriesRenderForm($state);
        return;
    }
    ?>
    <div class="cat-toolbar">
      <a class="btn" href="?tab=categories&new=1">+ Новая категория</a>
      <span class="set-hint">Вид чая или подборка. Чай может быть в нескольких категориях. Порядок — как в фильтре каталога.</span>
    </div>
    <div class="cat-list">
      <?php foreach ($state['list'] as $c): ?>
        <?php $img = !empty($c['imageUrl']) ? '/' . ltrim((string) $c['imageUrl'], '/') : null; ?>
        <a class="cat-row<?= empty($c['active']) ? ' off' : '' ?>" href="?tab=categories&id=<?= esc(rawurlencode((string) $c['id'])) ?>">
          <span class="prod-thumb"<?= $img ? ' style="background-image:url(\'' . esc($img) . '\')"' : '' ?>><?= $img ? '' : 'нет фото' ?></span>
          <span class="cat-main">
            <b><?= esc($c['name'] ?? '') ?></b><?= empty($c['active']) ? ' <span class="badge">выключена</span>' : '' ?>
            <span class="set-hint">/catalog/<?= esc($c['id']) ?> · чаёв: <?= (int) ($c['count'] ?? 0) ?> · порядок <?= (int) ($c['sortOrder'] ?? 0) ?></span>
          </span>
        </a>
      <?php endforeach; ?>
    </div>
    <?php
}

function categoriesRenderForm(array $state): void
{
    $isNew = $state['isNew'];
    $c = $state['form'] ?? $state['cat'] ?? ['name' => '', 'description' => '', 'active' => true, 'sortOrder' => '', 'seoText' => ''];
    if ($state['form'] && $state['cat']) { $c = array_merge($state['cat'], $state['form']); }
    $id = (string) ($state['cat']['id'] ?? '');
    $teaIds = $state['form']['teaIds'] ?? null;
    $img = !empty($c['imageUrl']) ? '/' . ltrim((string) $c['imageUrl'], '/') : null;
    ?>
    <a class="back-link" href="?tab=categories">← все категории</a>
    <?php if (!$isNew): ?>
      <div class="set-hint">На сайте: <a href="https://gorodchaya.ru/catalog/<?= esc($id) ?>" target="_blank" rel="noopener">gorodchaya.ru/catalog/<?= esc($id) ?></a><?= empty($c['active']) ? ' — сейчас выключена, страницы нет' : '' ?></div>
    <?php endif; ?>

    <form method="post" action="?tab=categories<?= $isNew ? '&new=1' : '&id=' . esc(rawurlencode($id)) ?>">
      <input type="hidden" name="action" value="save">
      <section class="set-card">
        <h2><?= $isNew ? 'Новая категория' : esc($c['name'] ?? '') ?></h2>
        <div class="set-grid">
          <label>Название*<input name="name" required maxlength="100" value="<?= esc($c['name'] ?? '') ?>" placeholder="Коллекция НГ 2027"></label>
          <?php if ($isNew): ?>
            <label>Адрес страницы <small>(латиница; пусто — из названия; потом не меняется)</small><input name="id" maxlength="60" pattern="[a-z0-9]+(-[a-z0-9]+)*" value="<?= esc($c['id'] ?? '') ?>" placeholder="ng-2027"></label>
          <?php endif; ?>
          <label>Порядок в списке<input name="sortOrder" inputmode="numeric" value="<?= esc($c['sortOrder'] ?? '') ?>" placeholder="авто"></label>
          <label class="wide f-check"><span><input type="checkbox" name="active" <?= !empty($c['active']) ? 'checked' : '' ?>> Активна — видна в каталоге, есть своя страница и её можно выбрать для витрины</span></label>
          <label class="wide">Описание (видно на странице категории; можно HTML)<textarea name="description" rows="3"><?= esc($c['description'] ?? '') ?></textarea></label>
        </div>
      </section>

      <section class="set-card">
        <h2>SEO</h2>
        <div class="set-grid">
          <label class="wide">Заголовок страницы (title) <small>пусто — «<?= esc(($c['name'] ?? 'Название') . ' — купить в «Чайном городе»') ?>»</small><input name="seoTitle" maxlength="120" value="<?= esc($c['seoTitle'] ?? '') ?>"></label>
          <label class="wide">Описание для поисковиков (description, до 300 знаков)<textarea name="seoDescription" rows="2" maxlength="300"><?= esc($c['seoDescription'] ?? '') ?></textarea></label>
          <label class="wide">SEO-текст внизу страницы (можно HTML)<textarea name="seoText" rows="5"><?= esc($c['seoText'] ?? '') ?></textarea></label>
        </div>
      </section>

      <section class="set-card">
        <h2>Чаи в категории</h2>
        <p class="set-hint">Отмеченные чаи попадут в категорию. У кого она основная — снять здесь нельзя, это делается в карточке чая.</p>
        <input type="search" class="cat-filter" placeholder="Найти чай…" data-cat-filter>
        <div class="cat-teas">
          <?php foreach ($state['teas'] as $t): ?>
            <?php
              $tc = (array) ($t['categories'] ?? []);
              $isMain = !$isNew && ($t['category'] ?? '') === $id;
              $on = $teaIds !== null ? in_array($t['id'], $teaIds, true) : (!$isNew && in_array($id, $tc, true));
            ?>
            <label class="cat-tea" data-name="<?= esc(mb_strtolower((string) ($t['name'] ?? ''))) ?>">
              <input type="checkbox" name="teaIds[]" value="<?= esc($t['id']) ?>" <?= $on || $isMain ? 'checked' : '' ?> <?= $isMain ? 'onclick="return false" title="основная категория чая"' : '' ?>>
              <?= esc($t['name'] ?? '') ?> <span class="set-hint"><?= esc($t['categoryLabel'] ?? '') ?><?= $isMain ? ' · основная' : '' ?></span>
            </label>
          <?php endforeach; ?>
        </div>
      </section>
      <button class="btn" type="submit">Сохранить</button>
    </form>

    <?php if (!$isNew): ?>
      <section class="set-card" style="margin-top:18px;">
        <h2>Картинка-превью</h2>
        <?php if ($img): ?><img src="<?= esc($img) ?>" alt="" style="width:140px;height:140px;object-fit:cover;border-radius:12px;display:block;margin-bottom:10px;"><?php endif; ?>
        <form method="post" enctype="multipart/form-data" action="?tab=categories&id=<?= esc(rawurlencode($id)) ?>" class="set-inline">
          <input type="hidden" name="action" value="photo">
          <input type="file" name="photo" accept="image/jpeg,image/png,image/webp" required>
          <button class="btn" type="submit">Загрузить</button>
        </form>
      </section>
      <form method="post" action="?tab=categories&id=<?= esc(rawurlencode($id)) ?>" onsubmit="return confirm('Удалить категорию «<?= esc($c['name'] ?? '') ?>»? У чаёв она снимется.')" style="margin-top:14px;">
        <input type="hidden" name="action" value="delete">
        <button class="link-btn" type="submit">удалить категорию</button>
      </form>
    <?php endif; ?>
    <script>
    (function () {
      var f = document.querySelector('[data-cat-filter]');
      if (!f) return;
      f.addEventListener('input', function () {
        var q = f.value.trim().toLowerCase();
        document.querySelectorAll('.cat-tea').forEach(function (el) { el.style.display = !q || el.getAttribute('data-name').indexOf(q) !== -1 ? '' : 'none'; });
      });
    })();
    </script>
    <?php
}

function categoriesCss(): string
{
    return <<<'CSS'
<style>
  .cat-toolbar { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
  .cat-toolbar .btn { text-decoration: none; }
  .cat-list { display: flex; flex-direction: column; gap: 8px; }
  .cat-row { display: flex; gap: 14px; align-items: center; background: var(--tea-paper); border: 1px solid var(--tea-border); border-radius: 12px; padding: 10px 14px; text-decoration: none; color: var(--tea-text); }
  .cat-row:hover { border-color: var(--tea-green); }
  .cat-row.off { opacity: .6; }
  .cat-main { display: flex; flex-direction: column; gap: 2px; font-size: 14px; }
  .cat-main .set-hint { margin: 0; }
  .prod-thumb { width: 52px; height: 52px; border-radius: 10px; background: #efe8d8 center/cover no-repeat; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; color: var(--tea-muted); flex-shrink: 0; }
  .badge { font-size: 11px; font-weight: 700; background: #efe8d8; color: var(--tea-muted); border-radius: 999px; padding: 1px 8px; }
  .cat-teas { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 6px 14px; max-height: 420px; overflow: auto; padding: 4px 0; }
  .cat-tea { font-size: 13.5px; display: flex; gap: 6px; align-items: baseline; }
  .cat-tea .set-hint { margin: 0; font-size: 11.5px; }
  .cat-filter { border: 1px solid var(--tea-border); border-radius: 8px; padding: 7px 10px; font: inherit; font-size: 13.5px; width: 100%; max-width: 320px; margin-bottom: 10px; }
  .f-check { flex-direction: row !important; align-items: center; color: var(--tea-text) !important; font-size: 13.5px !important; }
</style>
CSS;
}
