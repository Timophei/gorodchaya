<?php

declare(strict_types=1);

/**
 * Смотрелка диалогов + заказы — служебная страница. Никакого отдельного
 * логина внутри PHP нет: доступ закрывается на уровне nginx (HTTP Basic
 * Auth), см. deploy/nginx.conf.example и раздел про /admin/ в
 * РАЗВЁРТЫВАНИЕ_НА_СЕРВЕРЕ.md — без этого страница ОТКРЫТА ВСЕМ.
 *
 * Две вкладки в одном файле (?tab=dialogs — по умолчанию, ?tab=orders):
 *
 * — «Диалоги»: источник данных — logs/requests.log (построчный JSON, одна
 *   запись = один обмен "вопрос/ответ"). Он содержит больше, чем
 *   storage/conversations/*.json (там нет времени, модели, токенов), поэтому
 *   смотрелка построена именно на нём.
 *
 *   Важный момент устройства: conversation_id (он же значение cookie tea_cid)
 *   живёт 30 дней и, по сути, идентифицирует ГОСТЯ, а не один разговор — если
 *   человек вернулся на сайт через день с тем же браузером/cookie, новые
 *   сообщения технически допишутся в ту же историю. Чтобы это не превращало
 *   смотрелку в "простыню" из всех визитов подряд, история каждого гостя
 *   здесь разбивается на отдельные ДИАЛОГИ — по паузам между сообщениями
 *   (см. SESSION_GAP_SECONDS): если пауза больше получаса, считаем, что
 *   начался новый диалог того же гостя. Именно диалог, а не гость — основная
 *   единица в списке; гость — это просто ярлык, к которому диалог привязан.
 *
 * — «Заказы»: источник данных — Node-бэкенд витрины (chainy-gorod-backend),
 *   слушающий на 127.0.0.1:4000. Эта страница ходит туда напрямую (по
 *   localhost, наружу этот порт не торчит) с заголовком x-api-key — тем же
 *   ключом, что бэкенд использует для своих собственных write-эндпоинтов.
 *   Ключ лежит в .env этого проекта (CHAYGOROD_API_KEY), не в коде.
 */

require __DIR__ . '/../../src/Config.php';

Config::load();

$root = dirname(__DIR__, 2);
$logPath = $root . '/logs/requests.log';

const MAX_LOG_LINES = 20000;
const DIALOGS_PER_PAGE = 40;
const SESSION_GAP_SECONDS = 1800;

const ORDERS_API_BASE = 'http://127.0.0.1:4000/api';
const ORDER_STATUS_LABELS = [
    'new' => 'Новый',
    'processing' => 'В работе',
    'shipped' => 'Отправлен',
    'done' => 'Выполнен',
    'cancelled' => 'Отменён',
];
const PAYMENT_LABELS = ['cash' => 'наличные', 'card' => 'карта', 'transfer' => 'перевод'];

function esc($value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function mbTruncate(string $text, int $len): string
{
    $text = trim($text);
    if (mb_strlen($text) <= $len) {
        return $text;
    }
    return mb_substr($text, 0, $len) . '…';
}

function fmtTime(?string $iso): string
{
    if (!$iso) {
        return '—';
    }
    $ts = strtotime($iso);
    if ($ts === false) {
        return esc($iso);
    }
    return date('d.m.Y H:i:s', $ts);
}

// ---------- Заказы: обращение к внутреннему API бэкенда ----------

function ordersApiKey(): string
{
    return (string) Config::get('CHAYGOROD_API_KEY', '');
}

/**
 * @return array{ok: bool, data: mixed}
 */
function ordersApiRequest(string $method, string $path, ?array $body = null): array
{
    $apiKey = ordersApiKey();
    if ($apiKey === '') {
        return ['ok' => false, 'data' => null, 'error' => 'CHAYGOROD_API_KEY не задан в .env'];
    }

    $headers = "X-Api-Key: {$apiKey}\r\nAccept: application/json\r\n";
    $options = [
        'method' => $method,
        'header' => $headers,
        'timeout' => 5,
        'ignore_errors' => true,
    ];
    if ($body !== null) {
        $options['header'] .= "Content-Type: application/json\r\n";
        $options['content'] = json_encode($body, JSON_UNESCAPED_UNICODE);
    }

    $ctx = stream_context_create(['http' => $options]);
    $raw = @file_get_contents(ORDERS_API_BASE . $path, false, $ctx);
    if ($raw === false) {
        return ['ok' => false, 'data' => null, 'error' => 'Бэкенд недоступен (127.0.0.1:4000)'];
    }

    $statusLine = $http_response_header[0] ?? '';
    $statusOk = (bool) preg_match('#\s(2\d\d)\s#', $statusLine);

    $decoded = json_decode($raw, true);
    return ['ok' => $statusOk, 'data' => $decoded, 'error' => $statusOk ? null : ($decoded['error'] ?? 'Ошибка запроса')];
}

function fetchOrders(): array
{
    $result = ordersApiRequest('GET', '/orders');
    if (!$result['ok'] || !is_array($result['data'])) {
        return [];
    }
    return $result['data']['orders'] ?? [];
}

require __DIR__ . '/products.php';

// ---------- Параметры запроса ----------

$tab = in_array($_GET['tab'] ?? '', ['orders', 'users', 'products'], true) ? $_GET['tab'] : 'dialogs';
// Карточка одного пользователя: ?tab=users&u=<ключ> (u_<telegramId> или v_<метка браузера>).
$userKey = ($tab === 'users' && isset($_GET['u']) && is_string($_GET['u']) && preg_match('/^[uvp]_[A-Za-z0-9_-]{1,80}$/', $_GET['u'])) ? $_GET['u'] : null;

// Смена статуса заказа — обычный POST-редирект (PRG), чтобы обновление
// страницы не отправляло форму повторно.
$statusUpdateError = null;
if ($tab === 'orders' && $_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['order_id'], $_POST['status'])) {
    $result = ordersApiRequest('POST', '/orders/' . rawurlencode((string) $_POST['order_id']) . '/status', [
        'status' => (string) $_POST['status'],
    ]);
    if ($result['ok']) {
        header('Location: ?tab=orders');
        exit;
    }
    $statusUpdateError = $result['error'] ?? 'Не удалось обновить статус';
}

// Продажа в магазине, удаление заказа, удаление всех тестовых — тоже PRG.
$saleError = null;
$saleForm = [];
if ($tab === 'orders' && $_SERVER['REQUEST_METHOD'] === 'POST' && in_array($_POST['action'] ?? '', ['offline', 'delete', 'delete_tests'], true)) {
    $action = (string) $_POST['action'];
    if ($action === 'offline') {
        $saleForm = $_POST;
        $items = [];
        foreach ((array) ($_POST['sale_item'] ?? []) as $i => $key) {
            $key = (string) $key;
            if ($key === '') {
                continue;
            }
            [$teaId, $w] = array_pad(explode('|', $key, 2), 2, '0');
            $item = ['teaId' => $teaId, 'weightGrams' => (int) $w, 'qty' => max(1, (int) ($_POST['sale_qty'][$i] ?? 1))];
            $priceRaw = preg_replace('/\D/', '', (string) ($_POST['sale_price'][$i] ?? ''));
            if ($priceRaw !== '') {
                $item['unitPrice'] = (int) $priceRaw;
            }
            $items[] = $item;
        }
        if (!$items) {
            $saleError = 'Выберите хотя бы один товар.';
        } else {
            $result = ordersApiRequest('POST', '/admin/orders/offline', [
                'items' => $items,
                'payment' => in_array($_POST['sale_payment'] ?? '', array_keys(PAYMENT_LABELS), true) ? $_POST['sale_payment'] : 'cash',
                'customer' => [
                    'name' => trim((string) ($_POST['sale_name'] ?? '')),
                    'phone' => trim((string) ($_POST['sale_phone'] ?? '')),
                    'comment' => trim((string) ($_POST['sale_comment'] ?? '')),
                ],
                'seller' => trim((string) ($_POST['sale_seller'] ?? '')),
                'test' => !empty($_POST['sale_test']),
            ]);
            if ($result['ok']) {
                header('Location: ?tab=orders&sold=' . (int) ($result['data']['order']['number'] ?? 0));
                exit;
            }
            $saleError = $result['error'] ?? 'Не удалось провести продажу';
        }
    } else {
        $ids = [];
        if ($action === 'delete') {
            $ids[] = (string) ($_POST['order_id'] ?? '');
        } else {
            foreach (fetchOrders() as $o) {
                if (!empty($o['test'])) {
                    $ids[] = (string) $o['id'];
                }
            }
        }
        $n = 0;
        foreach ($ids as $id) {
            if ($id !== '' && ordersApiRequest('DELETE', '/orders/' . rawurlencode($id))['ok']) {
                $n++;
            }
        }
        header('Location: ?tab=orders&deleted=' . $n);
        exit;
    }
}

// ---------- Загрузка и разбор лога диалогов (только когда нужно) ----------

$dialogs = [];
$byGuest = [];
$entries = [];
$totalLinesRead = 0;
$view = 'list';
$selectedId = null;
$search = '';
$onlyErrors = false;
$page = 1;

// Диалоги нужны и в карточке пользователя — там показываются его переписки.
if ($tab === 'dialogs' || $userKey !== null) {
    /**
     * Эффективно читает последние $maxLines строк файла, не загружая его целиком.
     *
     * @return array<int, string>
     */
    function tailLines(string $path, int $maxLines): array
    {
        if (!is_file($path) || !is_readable($path)) {
            return [];
        }

        $fh = fopen($path, 'r');
        if ($fh === false) {
            return [];
        }

        $chunkSize = 65536;
        fseek($fh, 0, SEEK_END);
        $pos = ftell($fh);
        $buffer = '';
        $lineCount = 0;

        while ($pos > 0 && $lineCount <= $maxLines) {
            $readSize = (int) min($chunkSize, $pos);
            $pos -= $readSize;
            fseek($fh, $pos);
            $chunk = fread($fh, $readSize);
            if ($chunk === false) {
                break;
            }
            $buffer = $chunk . $buffer;
            $lineCount = substr_count($buffer, "\n");
        }
        fclose($fh);

        $lines = explode("\n", $buffer);
        $lines = array_values(array_filter($lines, static fn ($l) => trim($l) !== ''));

        if (count($lines) > $maxLines) {
            $lines = array_slice($lines, -$maxLines);
        }

        return $lines;
    }

    function fmtTokens(array $entry): string
    {
        $in = $entry['input_tokens'] ?? null;
        $out = $entry['output_tokens'] ?? null;
        $cached = $entry['cached_input_tokens'] ?? null;
        if ($in === null && $out === null) {
            return '';
        }
        $parts = [];
        if ($in !== null) {
            $parts[] = "вх. {$in}" . ($cached ? " (из них кэш {$cached})" : '');
        }
        if ($out !== null) {
            $parts[] = "исх. {$out}";
        }
        return implode(', ', $parts);
    }

    function shortGuestId(string $cid): string
    {
        return mb_strlen($cid) > 14 ? mb_substr($cid, 0, 14) . '…' : $cid;
    }

    /**
     * Сводка по одному диалогу (уже разбитому по сессии куску истории гостя).
     */
    function summarizeDialog(array $entries): array
    {
        $hasError = false;
        $tokensIn = 0;
        $tokensOut = 0;
        $preview = '';
        foreach ($entries as $e) {
            if (isset($e['error'])) {
                $hasError = true;
            }
            $tokensIn += (int) ($e['input_tokens'] ?? 0);
            $tokensOut += (int) ($e['output_tokens'] ?? 0);
            if ($preview === '' && isset($e['question']) && trim((string) $e['question']) !== '') {
                $preview = (string) $e['question'];
            }
        }
        $first = $entries[0] ?? [];
        $last = end($entries) ?: [];
        return [
            'count' => count($entries),
            'first_time' => $first['timestamp'] ?? null,
            'last_time' => $last['timestamp'] ?? null,
            'has_error' => $hasError,
            'tokens_in' => $tokensIn,
            'tokens_out' => $tokensOut,
            'preview' => $preview,
        ];
    }

    /**
     * Журнал ротируется каждую ночь (logrotate: requests.log -> .1 -> .2.gz ...),
     * поэтому читаем текущий файл и архивы, от новых к старым, пока не наберём
     * MAX_LOG_LINES строк. Иначе после полуночи вчерашние диалоги «пропадают».
     *
     * @return array<int, string>
     */
    function readLogWithArchives(string $path, int $maxLines): array
    {
        $files = [$path, $path . '.1'];
        $archives = glob($path . '.*.gz') ?: [];
        usort($archives, static function (string $a, string $b): int {
            preg_match('/\.(\d+)\.gz$/', $a, $ma);
            preg_match('/\.(\d+)\.gz$/', $b, $mb);
            return ((int) ($ma[1] ?? 0)) <=> ((int) ($mb[1] ?? 0));
        });
        $files = array_merge($files, $archives);

        $collected = [];
        foreach ($files as $file) {
            if (!is_file($file) || !is_readable($file)) {
                continue;
            }
            if (str_ends_with($file, '.gz')) {
                $lines = @gzfile($file) ?: [];
            } else {
                $lines = tailLines($file, $maxLines);
            }
            $lines = array_values(array_filter(array_map('rtrim', $lines), static fn ($l) => trim($l) !== ''));
            $collected = array_merge($lines, $collected); // более старый файл — в начало
            if (count($collected) >= $maxLines) {
                break;
            }
        }
        if (count($collected) > $maxLines) {
            $collected = array_slice($collected, -$maxLines);
        }
        return $collected;
    }

    $rawLines = readLogWithArchives($logPath, MAX_LOG_LINES);
    $totalLinesRead = count($rawLines);

    foreach ($rawLines as $line) {
        $decoded = json_decode($line, true);
        if (is_array($decoded)) {
            $entries[] = $decoded;
        }
    }

    // Шаг 1: группируем "сырые" записи по гостю (conversation_id / cookie tea_cid).
    foreach ($entries as $entry) {
        $cid = is_string($entry['conversation_id'] ?? null) ? $entry['conversation_id'] : 'unknown';
        $byGuest[$cid][] = $entry;
    }

    // Шаг 2: внутри истории каждого гостя нарезаем отдельные диалоги по паузам между сообщениями.
    foreach ($byGuest as $cid => $guestEntries) {
        $sessions = [];
        $current = [];
        $prevTs = null;

        foreach ($guestEntries as $entry) {
            $tsRaw = is_string($entry['timestamp'] ?? null) ? strtotime($entry['timestamp']) : false;
            $ts = $tsRaw !== false ? $tsRaw : null;

            if ($current !== [] && $prevTs !== null && $ts !== null && ($ts - $prevTs) > SESSION_GAP_SECONDS) {
                $sessions[] = $current;
                $current = [];
            }

            $current[] = $entry;
            if ($ts !== null) {
                $prevTs = $ts;
            }
        }
        if ($current !== []) {
            $sessions[] = $current;
        }

        $guestTotal = count($sessions);
        foreach ($sessions as $idx => $sessionEntries) {
            $dialogId = $cid . '~' . $idx;
            $dialogs[$dialogId] = [
                'guest_id' => $cid,
                'guest_index' => $idx + 1,
                'guest_total' => $guestTotal,
                'entries' => $sessionEntries,
            ];
        }
    }

    uasort($dialogs, static function (array $a, array $b): int {
        $ta = end($a['entries'])['timestamp'] ?? '';
        $tb = end($b['entries'])['timestamp'] ?? '';
        return strcmp((string) $tb, (string) $ta);
    });

    $selectedId = isset($_GET['id']) && is_string($_GET['id']) ? $_GET['id'] : null;
    $view = ($selectedId !== null && isset($dialogs[$selectedId])) ? 'detail' : 'list';

    $search = trim((string) ($_GET['q'] ?? ''));
    $onlyErrors = isset($_GET['errors']);
    $page = max(1, (int) ($_GET['page'] ?? 1));
}

// ---------- Заказы: загрузка (только на вкладке «Заказы») ----------

$orders = [];
$ordersError = null;
if ($tab === 'orders') {
    $apiKey = ordersApiKey();
    if ($apiKey === '') {
        $ordersError = 'В .env не задан CHAYGOROD_API_KEY — страница не может получить заказы у бэкенда.';
    } else {
        $catalogResult = ordersApiRequest('GET', '/teas');
        $saleCatalog = $catalogResult['ok'] && is_array($catalogResult['data']) ? $catalogResult['data'] : [];
        $result = ordersApiRequest('GET', '/orders');
        if ($result['ok'] && is_array($result['data'])) {
            $orders = $result['data']['orders'] ?? [];
        } else {
            $ordersError = $result['error'] ?? 'Не удалось получить заказы';
        }
    }
}

// ---------- Пользователи: загрузка (только на вкладке «Пользователи») ----------

$people = [];
$person = null;
$personOrders = [];
$personViews = [];
$personDialogs = [];
$usersError = null;
if ($tab === 'users') {
    if ($userKey !== null) {
        $result = ordersApiRequest('GET', '/admin/people/' . rawurlencode($userKey));
        if ($result['ok'] && is_array($result['data']) && is_array($result['data']['person'] ?? null)) {
            $person = $result['data']['person'];
            $personOrders = is_array($result['data']['orders'] ?? null) ? $result['data']['orders'] : [];
            $personViews = is_array($result['data']['views'] ?? null) ? $result['data']['views'] : [];
            $cids = is_array($result['data']['cids'] ?? null) ? $result['data']['cids'] : [];
            foreach ($dialogs as $dialogId => $dialogData) {
                if (in_array($dialogData['guest_id'], $cids, true)) {
                    $personDialogs[$dialogId] = $dialogData;
                }
            }
        } else {
            $usersError = $result['error'] === 'not_found' ? 'Такого пользователя нет.' : ($result['error'] ?? 'Не удалось получить пользователя');
        }
    } else {
        $result = ordersApiRequest('GET', '/admin/people');
        if ($result['ok'] && is_array($result['data'])) {
            $people = $result['data']['people'] ?? [];
        } else {
            $usersError = $result['error'] ?? 'Не удалось получить пользователей';
        }
    }
}

function personTitle(array $p): string
{
    if (in_array($p['kind'] ?? '', ['guest', 'shop'], true) && is_array($p['contact'] ?? null) && !empty($p['contact']['name'])) {
        return (string) $p['contact']['name'];
    }
    return (string) ($p['name'] ?? '—');
}

function personKindLabel(array $p): string
{
    return ['user' => 'Telegram', 'shop' => 'покупатель магазина'][$p['kind'] ?? ''] ?? 'гость';
}

/** Позиция заказа: «Название · 50 г × 2», посуда — без граммов. */
function orderItemLabel(array $it): string
{
    return ($it['name'] ?? '—') . (!empty($it['weightGrams']) ? ' · ' . $it['weightGrams'] . ' г' : '') . ' × ' . (int) ($it['qty'] ?? 1);
}

/** Варианты для выбора товара в продаже: «id|граммы» => подпись, по разделам. */
function saleOptions(array $teas): array
{
    $groups = [];
    foreach ($teas as $t) {
        foreach ((array) ($t['prices'] ?? []) as $p) {
            $w = (int) ($p['weightGrams'] ?? 0);
            $st = $p['stock'] ?? null;
            $label = ($t['name'] ?? '') . ($w ? ' · ' . $w . ' г' : '') . ' — ' . number_format((int) ($p['price'] ?? 0), 0, '', ' ') . ' ₽'
                . ' (' . ($st === null ? 'остаток не ведётся' : 'ост. ' . $st) . ')';
            $groups[PRODUCT_CATEGORIES[$t['category'] ?? ''] ?? 'Другое'][] = [
                'value' => ($t['id'] ?? '') . '|' . $w, 'label' => $label, 'price' => (int) ($p['price'] ?? 0),
            ];
        }
    }
    ksort($groups);
    return $groups;
}

function plural(int $n, string $one, string $few, string $many): string
{
    $n10 = $n % 10; $n100 = $n % 100;
    if ($n10 === 1 && $n100 !== 11) { return $one; }
    if ($n10 >= 2 && $n10 <= 4 && ($n100 < 12 || $n100 > 14)) { return $few; }
    return $many;
}

/** Ключ карточки пользователя для заказа: аккаунт, если был вход, иначе метка браузера. */
function orderPersonKey(array $o): ?string
{
    if (is_string($o['userId'] ?? null) && preg_match('/^tg:(\d+)$/', $o['userId'], $m)) {
        return 'u_' . $m[1];
    }
    if (is_string($o['visitorId'] ?? null) && $o['visitorId'] !== '') {
        return 'v_' . $o['visitorId'];
    }
    return null;
}

// ---------- Продукты: обработка до вывода (там бывают редиректы и JSON) ----------

$productsState = $tab === 'products' ? productsHandle() : null;

// ---------- Рендер ----------

header('Content-Type: text/html; charset=utf-8');
header('X-Robots-Tag: noindex, nofollow');
header('Cache-Control: no-store');

?><!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Чайный город — админка</title>
<link rel="icon" type="image/png" href="../assets/favicon-32.png">
<style>
  :root {
    --tea-green: #3f6b4f;
    --tea-green-dark: #2d4b2e;
    --tea-cream: #f7f1e6;
    --tea-cream-deep: #fef9f3;
    --tea-paper: #ffffff;
    --tea-text: #2a2a26;
    --tea-muted: #7a7266;
    --tea-border: #e6ddc9;
    --tea-user-bubble: #2d4b2e;
    --tea-bot-bubble: #f2ead9;
    --tea-accent: #a52b19;
    --tea-error-bg: #fbe9e5;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--tea-cream);
    color: var(--tea-text);
  }
  .wrap { max-width: 960px; margin: 0 auto; padding: 0 18px 60px; }
  header.top {
    background: var(--tea-cream-deep);
    border-bottom: 1px solid var(--tea-border);
    padding: 18px;
    margin-bottom: 22px;
  }
  header.top .inner { max-width: 960px; margin: 0 auto; }
  header.top .row1 { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  h1 { font-size: 19px; margin: 0; color: var(--tea-green-dark); }
  .sub { font-size: 12.5px; color: var(--tea-muted); }
  a { color: var(--tea-green-dark); }
  .back-link { display: inline-block; margin-bottom: 16px; font-size: 13.5px; text-decoration: none; color: var(--tea-muted); }
  .back-link:hover { color: var(--tea-green-dark); }

  .tabs { display: flex; gap: 8px; margin-top: 14px; }
  .tab {
    padding: 6px 16px; border-radius: 999px; border: 1px solid var(--tea-border);
    text-decoration: none; color: var(--tea-muted); font-size: 13.5px; font-weight: 600;
  }
  .tab.active { background: var(--tea-green-dark); color: #fff; border-color: var(--tea-green-dark); }
  .tab:hover:not(.active) { border-color: var(--tea-green); color: var(--tea-green-dark); }

  form.filters { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 20px; }
  form.filters input[type="text"] {
    flex: 1; min-width: 180px;
    padding: 9px 12px; border: 1px solid var(--tea-border); border-radius: 8px;
    font-size: 14px; background: var(--tea-paper);
  }
  form.filters label { font-size: 13px; color: var(--tea-muted); display: flex; align-items: center; gap: 5px; white-space: nowrap; }
  .btn {
    border: none; border-radius: 8px; padding: 9px 16px; font-size: 14px;
    cursor: pointer; background: var(--tea-green); color: #fff; font-weight: 600;
  }
  .btn:hover { opacity: 0.88; }

  .conv-card {
    display: block; text-decoration: none; color: inherit;
    background: var(--tea-paper); border: 1px solid var(--tea-border); border-radius: 12px;
    padding: 14px 16px; margin-bottom: 10px; transition: border-color 0.15s ease;
  }
  .conv-card:hover { border-color: var(--tea-green); }
  .conv-card .row1 { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; color: var(--tea-muted); margin-bottom: 6px; }
  .conv-card .guest { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .conv-card .preview { font-size: 14.5px; line-height: 1.4; margin-bottom: 8px; }
  .conv-card .badges { display: flex; gap: 6px; flex-wrap: wrap; }
  .badge { font-size: 11.5px; padding: 3px 8px; border-radius: 999px; background: var(--tea-bot-bubble); color: var(--tea-green-dark); }
  .badge.error { background: var(--tea-error-bg); color: var(--tea-accent); font-weight: 600; }
  .badge.guest-visit { background: transparent; border: 1px solid var(--tea-border); color: var(--tea-muted); }

  .empty { color: var(--tea-muted); padding: 30px 0; text-align: center; }

  .pager { display: flex; gap: 10px; justify-content: center; margin-top: 20px; font-size: 13.5px; }
  .pager a, .pager span { padding: 6px 12px; border: 1px solid var(--tea-border); border-radius: 8px; text-decoration: none; color: var(--tea-green-dark); }
  .pager .current { background: var(--tea-green-dark); color: #fff; border-color: var(--tea-green-dark); }

  /* --- детальный просмотр одного диалога, стиль пузырьков как на самом сайте --- */
  .dialog-header { margin-bottom: 18px; }
  .dialog-header .title { font-size: 15.5px; font-weight: 600; color: var(--tea-green-dark); margin-bottom: 4px; }
  .dialog-header .guest-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; color: var(--tea-muted); }
  .sibling-nav { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
  .sibling-nav a, .sibling-nav .current-dialog {
    font-size: 12.5px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--tea-border);
    text-decoration: none; color: var(--tea-muted);
  }
  .sibling-nav .current-dialog { background: var(--tea-green-dark); color: #fff; border-color: var(--tea-green-dark); }
  .sibling-nav a:hover { border-color: var(--tea-green); color: var(--tea-green-dark); }

  .exchange { margin-bottom: 26px; }
  .exchange .meta { font-size: 12px; color: var(--tea-muted); margin-bottom: 8px; display: flex; gap: 10px; flex-wrap: wrap; }
  .msg { max-width: 82%; padding: 10px 14px; border-radius: 16px; line-height: 1.45; font-size: 14.5px; white-space: pre-wrap; word-wrap: break-word; margin-bottom: 6px; }
  .msg--user { background: var(--tea-user-bubble); color: #fff; border-bottom-right-radius: 4px; margin-left: auto; }
  .msg--bot { background: var(--tea-bot-bubble); color: var(--tea-text); border-bottom-left-radius: 4px; }
  .msg--error { background: var(--tea-error-bg); color: var(--tea-accent); border-bottom-left-radius: 4px; }
  .msg__followup { margin-top: 6px; font-style: italic; color: var(--tea-green-dark); font-size: 13.5px; }
  .msg__products { margin-top: 6px; font-size: 12.5px; color: var(--tea-green-dark); }

  /* --- пользователи --- */
  .person-card { background: var(--tea-paper); border: 1px solid var(--tea-border); border-radius: 12px; padding: 18px; margin-bottom: 8px; }
  .person-name { font-size: 20px; font-weight: 700; margin-bottom: 10px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .person-facts { font-size: 13.5px; line-height: 1.7; color: var(--tea-muted); }
  .person-facts a { color: var(--tea-green-dark); }
  .section-title { font-size: 15px; margin: 26px 0 12px; }
  .empty-inline, .hint { font-size: 13.5px; color: var(--tea-muted); }
  .hint a { color: var(--tea-green-dark); }
  .view-top { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
  .view-top a { text-decoration: none; }
  .view-list { background: var(--tea-paper); border: 1px solid var(--tea-border); border-radius: 12px; padding: 4px 16px; }
  .view-row { display: flex; justify-content: space-between; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--tea-border); font-size: 14px; }
  .view-row:last-child { border-bottom: none; }
  .view-row a { color: var(--tea-text); text-decoration: none; }
  .view-row a:hover { color: var(--tea-green-dark); text-decoration: underline; }
  .view-row span { color: var(--tea-muted); font-size: 12.5px; white-space: nowrap; }
  .order-customer a { color: var(--tea-green-dark); font-weight: 400; }

  /* --- заказы --- */
  .order-card {
    background: var(--tea-paper); border: 1px solid var(--tea-border); border-radius: 12px;
    padding: 16px; margin-bottom: 12px;
  }
  .order-card .row1 { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; color: var(--tea-muted); margin-bottom: 8px; }
  .order-card .order-number { font-weight: 700; color: var(--tea-green-dark); }
  .order-card .order-customer { font-size: 14.5px; font-weight: 600; margin-bottom: 2px; }
  .order-card .order-address { font-size: 13.5px; color: var(--tea-text); margin-bottom: 6px; }
  .order-card .order-comment { font-size: 13px; color: var(--tea-muted); font-style: italic; margin-bottom: 6px; }
  .order-card .order-items { font-size: 13.5px; color: var(--tea-text); margin: 8px 0; padding: 8px 0; border-top: 1px dashed var(--tea-border); border-bottom: 1px dashed var(--tea-border); }
  .order-card .order-items div { padding: 2px 0; }
  .order-card .order-total { font-size: 15px; font-weight: 700; margin: 8px 0; }
  .status-form { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .status-form select {
    padding: 7px 10px; border: 1px solid var(--tea-border); border-radius: 8px; font-size: 13.5px; background: var(--tea-paper);
  }
  .status-badge { font-size: 11.5px; padding: 3px 10px; border-radius: 999px; font-weight: 600; }
  .status-badge.new { background: var(--tea-bot-bubble); color: var(--tea-green-dark); }
  .status-badge.processing { background: #fdf1cf; color: #8a6a12; }
  .status-badge.shipped { background: #dbe7f3; color: #2b4f73; }
  .stock-note { font-size: 12.5px; color: var(--tea-muted); margin: 8px 0; line-height: 1.5; }
  .stock-note b { color: var(--tea-text); font-weight: 600; }
  .stock-note .warn { color: var(--tea-accent); }
  .status-badge.done { background: #dcefdd; color: var(--tea-green-dark); }
  .status-badge.cancelled { background: var(--tea-error-bg); color: var(--tea-accent); }
  .src-badge, .pre-badge, .test-badge, .pre-tag { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; margin-left: 6px; }
  .src-badge.site { background: var(--tea-bot-bubble); color: var(--tea-green-dark); }
  .src-badge.shop { background: #e9e2f3; color: #4f3b73; }
  .pre-badge, .pre-tag { background: #fdf1cf; color: #8a6a12; }
  .test-badge { background: #eee; color: #666; }
  .order-card.has-preorder { border-left: 4px solid #e0b43c; }
  .order-card.is-test { opacity: .75; border-style: dashed; }
  .order-items .item-pre { background: #fff8e3; margin: 0 -6px; padding: 2px 6px !important; border-radius: 6px; }
  .del-form { margin-top: 6px; text-align: right; }
  .link-btn { background: none; border: none; color: var(--tea-muted); font-size: 12px; text-decoration: underline; cursor: pointer; padding: 0; }
  .link-btn:hover { color: var(--tea-accent); }
  .sale-box { background: var(--tea-paper); border: 1px solid var(--tea-border); border-radius: 12px; padding: 12px 16px; margin-bottom: 14px; }
  .sale-box summary { cursor: pointer; font-weight: 700; color: var(--tea-green-dark); font-size: 14.5px; }
  .sale-box form { margin-top: 12px; }
  .sale-row { display: flex; gap: 8px; margin-bottom: 8px; }
  .sale-row select { flex: 1; min-width: 0; }
  .sale-box select, .sale-box input[type=text], .sale-box input[type=tel], .sale-box input[type=number] { padding: 8px 10px; border: 1px solid var(--tea-border); border-radius: 8px; font-size: 13.5px; background: #fff; font-family: inherit; }
  .sale-qty { width: 70px; } .sale-price { width: 90px; }
  .sale-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 12px 0 8px; }
  .sale-comment { width: 100%; box-sizing: border-box; }
  .sale-foot { display: flex; align-items: center; gap: 14px; margin-top: 10px; flex-wrap: wrap; }
  .sale-test { font-size: 13px; color: var(--tea-muted); flex: 1; }
  .sale-total { font-size: 15px; }
  .tests-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; background: #f3f1ec; border-radius: 10px; padding: 8px 14px; margin-bottom: 14px; font-size: 13.5px; }
  @media (max-width: 640px) { .sale-grid { grid-template-columns: 1fr; } .sale-row { flex-wrap: wrap; } .sale-row select { flex-basis: 100%; } }
  .api-error { background: var(--tea-error-bg); color: var(--tea-accent); border-radius: 10px; padding: 12px 16px; margin-bottom: 16px; font-size: 13.5px; }
<?= productsCss() ?>
</style>
</head>
<body>

<header class="top">
  <div class="inner">
    <div class="row1">
      <div>
        <h1>Чайный город — админка</h1>
        <?php if ($tab === 'dialogs'): ?>
          <div class="sub">
            Диалогов: <?= count($dialogs) ?>
            · гостей: <?= count($byGuest) ?>
            · записей в логе: <?= count($entries) ?><?= $totalLinesRead >= MAX_LOG_LINES ? ' (показан хвост, лог больше)' : '' ?>
          </div>
        <?php elseif ($tab === 'products'): ?>
          <div class="sub"><?= $productsState['tea'] !== null ? 'Карточка чая' : ($productsState['isNew'] ? 'Новый чай' : 'Чаёв: ' . count($productsState['list'])) ?></div>
        <?php elseif ($tab === 'users'): ?>
          <div class="sub"><?= $userKey !== null ? 'Карточка пользователя' : 'Пользователей: ' . count($people) ?></div>
        <?php else: ?>
          <div class="sub">Заказов: <?= count($orders) ?></div>
        <?php endif; ?>
      </div>
      <div class="sub"><a href="?tab=<?= esc($tab) ?><?= $userKey !== null ? '&u=' . esc($userKey) : '' ?>">обновить</a></div>
    </div>
    <div class="tabs">
      <a class="tab <?= $tab === 'dialogs' ? 'active' : '' ?>" href="?tab=dialogs">Диалоги</a>
      <a class="tab <?= $tab === 'orders' ? 'active' : '' ?>" href="?tab=orders">Заказы</a>
      <a class="tab <?= $tab === 'users' ? 'active' : '' ?>" href="?tab=users">Пользователи</a>
      <a class="tab <?= $tab === 'products' ? 'active' : '' ?>" href="?tab=products">Продукты</a>
    </div>
  </div>
</header>

<div class="wrap">

<?php if ($tab === 'orders'): ?>

  <?php if ($statusUpdateError): ?>
    <div class="api-error">Не удалось сохранить статус: <?= esc($statusUpdateError) ?></div>
  <?php endif; ?>

  <?php if (isset($_GET['sold'])): ?>
    <div class="flash">Продажа проведена — заказ №<?= (int) $_GET['sold'] ?>, остаток списан.</div>
  <?php elseif (isset($_GET['deleted'])): ?>
    <div class="flash">Удалено заказов: <?= (int) $_GET['deleted'] ?>. Списанный по ним остаток возвращён.</div>
  <?php endif; ?>

  <?php if (!$ordersError): ?>
    <?php $saleGroups = saleOptions($saleCatalog ?? []); $saleOpen = $saleError !== null || isset($_GET['sell']); ?>
    <details class="sale-box" <?= $saleOpen ? 'open' : '' ?>>
      <summary>+ Продажа в магазине</summary>
      <?php if ($saleError): ?><div class="api-error"><?= esc($saleError) ?></div><?php endif; ?>
      <form method="post" action="?tab=orders" data-sale-form>
        <input type="hidden" name="action" value="offline">
        <div data-sale-rows>
          <?php $rowsN = max(1, count(array_filter((array) ($saleForm['sale_item'] ?? []), 'strlen'))); for ($r = 0; $r < $rowsN; $r++): $selVal = (string) (($saleForm['sale_item'] ?? [])[$r] ?? ''); ?>
          <div class="sale-row">
            <select name="sale_item[]" data-sale-item>
              <option value="">— товар —</option>
              <?php foreach ($saleGroups as $group => $opts): ?>
                <optgroup label="<?= esc($group) ?>">
                  <?php foreach ($opts as $o): ?>
                    <option value="<?= esc($o['value']) ?>" data-price="<?= $o['price'] ?>" <?= $selVal === $o['value'] ? 'selected' : '' ?>><?= esc($o['label']) ?></option>
                  <?php endforeach; ?>
                </optgroup>
              <?php endforeach; ?>
            </select>
            <input type="number" name="sale_qty[]" min="1" value="<?= esc((string) (($saleForm['sale_qty'] ?? [])[$r] ?? 1)) ?>" class="sale-qty" data-sale-qty title="Количество">
            <input type="text" name="sale_price[]" inputmode="numeric" placeholder="цена" value="<?= esc((string) (($saleForm['sale_price'] ?? [])[$r] ?? '')) ?>" class="sale-price" data-sale-price title="Цена за штуку; пусто — по каталогу">
          </div>
          <?php endfor; ?>
        </div>
        <button class="btn btn-ghost" type="button" data-sale-add>+ ещё товар</button>
        <div class="sale-grid">
          <input type="text" name="sale_name" placeholder="Имя покупателя" value="<?= esc((string) ($saleForm['sale_name'] ?? '')) ?>">
          <input type="tel" name="sale_phone" placeholder="Телефон — чтобы покупатель попал в базу" value="<?= esc((string) ($saleForm['sale_phone'] ?? '')) ?>">
          <select name="sale_payment">
            <?php foreach (PAYMENT_LABELS as $v => $l): ?><option value="<?= $v ?>" <?= ($saleForm['sale_payment'] ?? 'cash') === $v ? 'selected' : '' ?>><?= esc(ucfirst($l)) ?></option><?php endforeach; ?>
          </select>
          <input type="text" name="sale_seller" placeholder="Кто продал" value="<?= esc((string) ($saleForm['sale_seller'] ?? '')) ?>">
        </div>
        <input type="text" name="sale_comment" placeholder="Комментарий" value="<?= esc((string) ($saleForm['sale_comment'] ?? '')) ?>" class="sale-comment">
        <div class="sale-foot">
          <label class="sale-test"><input type="checkbox" name="sale_test" value="1" <?= !empty($saleForm['sale_test']) ? 'checked' : '' ?>> тестовая (потом удалить одной кнопкой)</label>
          <span class="sale-total">Итого: <b data-sale-total>0</b> ₽</span>
          <button class="btn" type="submit">Провести продажу</button>
        </div>
        <div class="hint">Заказ сразу получает статус «Выполнен», остаток списывается. Если товара не было на полке — позиция помечается «под заказ», остаток уходит в минус.</div>
      </form>
    </details>
    <?php $testCount = count(array_filter($orders, static fn ($o) => !empty($o['test']))); ?>
    <?php if ($testCount): ?>
      <form method="post" action="?tab=orders" class="tests-bar" onsubmit="return confirm('Удалить все тестовые заказы (<?= $testCount ?>) и вернуть их остаток?')">
        <input type="hidden" name="action" value="delete_tests">
        <span>Тестовых заказов: <?= $testCount ?></span>
        <button class="btn btn-ghost" type="submit">Удалить все тестовые</button>
      </form>
    <?php endif; ?>
  <?php endif; ?>

  <?php if ($ordersError): ?>
    <div class="api-error"><?= esc($ordersError) ?></div>
  <?php elseif (empty($orders)): ?>
    <div class="empty">Заказов пока нет.</div>
  <?php else: ?>
    <?php foreach ($orders as $o): ?>
      <?php
        $status = is_string($o['status'] ?? null) ? $o['status'] : 'new';
        $customer = is_array($o['customer'] ?? null) ? $o['customer'] : [];
        $items = is_array($o['items'] ?? null) ? $o['items'] : [];
      ?>
      <?php $isShop = ($o['source'] ?? '') === 'offline'; $preItems = array_filter($items, static fn ($it) => (int) ($it['preorderQty'] ?? 0) > 0); ?>
      <div class="order-card<?= $preItems ? ' has-preorder' : '' ?><?= !empty($o['test']) ? ' is-test' : '' ?>">
        <div class="row1">
          <span>
            <span class="order-number">Заказ №<?= esc($o['number'] ?? '—') ?></span>
            <span class="src-badge <?= $isShop ? 'shop' : 'site' ?>"><?= $isShop ? 'магазин' . (!empty($o['payment']) ? ' · ' . esc(PAYMENT_LABELS[$o['payment']] ?? $o['payment']) : '') : 'сайт' ?></span>
            <?php if ($preItems): ?><span class="pre-badge">есть под заказ</span><?php endif; ?>
            <?php if (!empty($o['test'])): ?><span class="test-badge">тест</span><?php endif; ?>
          </span>
          <span><?= esc(fmtTime($o['createdAt'] ?? null)) ?><?= !empty($o['seller']) ? ' · продал: ' . esc($o['seller']) : '' ?></span>
        </div>
        <div class="order-customer"><?= esc($customer['name'] ?? '—') ?> · <?= esc($customer['phone'] ?? '—') ?><?php $pk = orderPersonKey($o); if ($pk !== null): ?> · <a href="?tab=users&u=<?= esc($pk) ?>">карточка покупателя</a><?php endif; ?></div>
        <?php if (!$isShop): ?><div class="order-address">Адрес: <?= esc($customer['address'] ?? '—') ?></div><?php endif; ?>
        <?php if (!empty($customer['comment'])): ?>
          <div class="order-comment">Комментарий: <?= esc($customer['comment']) ?></div>
        <?php endif; ?>
        <div class="order-items">
          <?php foreach ($items as $it): ?>
            <?php $pq = (int) ($it['preorderQty'] ?? 0); $q = (int) ($it['qty'] ?? 1); ?>
            <div class="<?= $pq ? 'item-pre' : '' ?>">
              <?= esc(orderItemLabel($it)) ?>
              — <?= number_format((int) ($it['unitPrice'] ?? 0) * $q, 0, '', ' ') ?> ₽
              <?php if ($pq): ?><span class="pre-tag"><?= $pq >= $q ? 'под заказ' : ($q - $pq) . ' есть, ' . $pq . ' под заказ' ?></span><?php endif; ?>
            </div>
          <?php endforeach; ?>
        </div>
        <div class="order-total">Итого: <?= number_format((int) ($o['total'] ?? 0), 0, '', ' ') ?> ₽<?= !empty($o['promoCode']) ? ' · промокод ' . esc($o['promoCode']) : '' ?></div>
        <?php $lastStock = is_array($o['stockLog'] ?? null) && $o['stockLog'] ? end($o['stockLog']) : null; ?>
        <?php if ($lastStock): ?>
          <div class="stock-note">
            <b><?= ($lastStock['action'] ?? '') === 'writeoff' ? 'Остаток списан' : 'Остаток возвращён' ?></b> <?= esc(fmtTime($lastStock['at'] ?? null)) ?>:
            <?= esc(implode('; ', array_map(static fn ($m) => ($m['name'] ?? '') . ', ' . (!empty($m['weightGrams']) ? $m['weightGrams'] . ' г' : 'шт') . ': ' . ($m['before'] ?? '?') . ' → ' . ($m['after'] ?? '?'), (array) ($lastStock['moves'] ?? [])))) ?>
            <?php if (!empty($lastStock['unmatched'])): ?>
              <br><span class="warn">Не нашлась фасовка, остаток не тронут: <?= esc(implode(', ', (array) $lastStock['unmatched'])) ?></span>
            <?php endif; ?>
          </div>
        <?php elseif (($o['status'] ?? '') !== 'shipped'): ?>
          <div class="stock-note">Остаток спишется при переводе в «Отправлен».</div>
        <?php endif; ?>
        <span class="status-badge <?= esc($status) ?>"><?= esc(ORDER_STATUS_LABELS[$status] ?? $status) ?></span>
        <form class="status-form" method="post" action="?tab=orders">
          <input type="hidden" name="order_id" value="<?= esc($o['id'] ?? '') ?>">
          <select name="status">
            <?php foreach (ORDER_STATUS_LABELS as $val => $label): ?>
              <option value="<?= esc($val) ?>" <?= $status === $val ? 'selected' : '' ?>><?= esc($label) ?></option>
            <?php endforeach; ?>
          </select>
          <button class="btn" type="submit">Сохранить</button>
        </form>
        <form method="post" action="?tab=orders" class="del-form" onsubmit="return confirm('Удалить заказ №<?= esc($o['number'] ?? '') ?>? Списанный остаток вернётся.')">
          <input type="hidden" name="action" value="delete">
          <input type="hidden" name="order_id" value="<?= esc($o['id'] ?? '') ?>">
          <button class="link-btn" type="submit">удалить заказ</button>
        </form>
      </div>
    <?php endforeach; ?>
  <?php endif; ?>

<?php elseif ($tab === 'products'): ?>

  <?php productsRender($productsState); ?>

<?php elseif ($tab === 'users'): ?>

  <?php if ($usersError): ?>
    <?php if ($userKey !== null): ?><a class="back-link" href="?tab=users">← ко всем пользователям</a><?php endif; ?>
    <div class="api-error"><?= esc($usersError) ?></div>

  <?php elseif ($person !== null): ?>
    <?php
      $isUser = ($person['kind'] ?? '') === 'user';
      $contact = is_array($person['contact'] ?? null) ? $person['contact'] : null;
      // Сводка «что смотрел чаще всего» — счётчик по чаям из истории просмотров.
      $viewTop = [];
      foreach ($personViews as $v) {
          $tid = (string) ($v['teaId'] ?? '');
          if ($tid === '') { continue; }
          if (!isset($viewTop[$tid])) { $viewTop[$tid] = ['name' => (string) ($v['name'] ?? $tid), 'count' => 0]; }
          $viewTop[$tid]['count']++;
      }
      uasort($viewTop, static fn (array $a, array $b): int => $b['count'] <=> $a['count']);
    ?>
    <a class="back-link" href="?tab=users">← ко всем пользователям</a>

    <div class="person-card">
      <div class="person-name"><?= esc(personTitle($person)) ?>
        <span class="badge <?= $isUser ? '' : 'guest-visit' ?>"><?= esc(personKindLabel($person)) ?></span>
      </div>
      <div class="person-facts">
        <?php if ($isUser && !empty($person['username'])): ?>
          <div>Telegram: <a href="https://t.me/<?= esc($person['username']) ?>" target="_blank" rel="noopener">@<?= esc($person['username']) ?></a></div>
        <?php endif; ?>
        <?php if ($isUser && !empty($person['telegramId'])): ?><div>Telegram ID: <?= esc($person['telegramId']) ?></div><?php endif; ?>
        <?php if ($contact !== null): ?>
          <div>Из заказа: <?= esc($contact['name'] ?? '—') ?><?= !empty($contact['phone']) ? ' · ' . esc($contact['phone']) : '' ?></div>
        <?php endif; ?>
        <div>Впервые: <?= esc(fmtTime($person['firstSeen'] ?? null)) ?> · последний раз: <?= esc(fmtTime($person['lastSeen'] ?? null)) ?></div>
        <div>
          Заказов: <?= (int) ($person['ordersCount'] ?? 0) ?><?= !empty($person['ordersTotal']) ? ' на ' . number_format((int) $person['ordersTotal'], 0, '', ' ') . ' ₽' : '' ?>
          · диалогов: <?= count($personDialogs) ?>
          · просмотров чаёв: <?= count($personViews) ?>
        </div>
      </div>
    </div>

    <h2 class="section-title">Заказы</h2>
    <?php if (empty($personOrders)): ?>
      <div class="empty-inline">Заказов нет.</div>
    <?php else: ?>
      <?php foreach ($personOrders as $o): ?>
        <?php
          $status = is_string($o['status'] ?? null) ? $o['status'] : 'new';
          $items = is_array($o['items'] ?? null) ? $o['items'] : [];
        ?>
        <div class="order-card">
          <div class="row1">
            <span class="order-number">Заказ №<?= esc($o['number'] ?? '—') ?></span>
            <span><?= esc(fmtTime($o['createdAt'] ?? null)) ?></span>
          </div>
          <div class="order-items">
            <?php foreach ($items as $it): ?>
              <div>
                <?= esc($it['name'] ?? '—') ?><?= !empty($it['weightGrams']) ? ' · ' . esc($it['weightGrams']) . ' г' : '' ?>
                × <?= (int) ($it['qty'] ?? 1) ?>
                — <?= number_format((int) ($it['unitPrice'] ?? 0) * (int) ($it['qty'] ?? 1), 0, '', ' ') ?> ₽
              </div>
            <?php endforeach; ?>
          </div>
          <div class="order-total">Итого: <?= number_format((int) ($o['total'] ?? 0), 0, '', ' ') ?> ₽</div>
          <span class="status-badge <?= esc($status) ?>"><?= esc(ORDER_STATUS_LABELS[$status] ?? $status) ?></span>
        </div>
      <?php endforeach; ?>
      <div class="hint">Статус меняется на вкладке <a href="?tab=orders">«Заказы»</a>.</div>
    <?php endif; ?>

    <h2 class="section-title">Диалоги с мастером</h2>
    <?php if (empty($personDialogs)): ?>
      <div class="empty-inline">Диалогов нет.</div>
    <?php else: ?>
      <?php foreach ($personDialogs as $dialogId => $dialogData): ?>
        <?php $summary = summarizeDialog($dialogData['entries']); ?>
        <a class="conv-card" href="?tab=dialogs&id=<?= urlencode($dialogId) ?>">
          <div class="row1">
            <span><?= (int) $summary['count'] ?> <?= plural((int) $summary['count'], 'обмен', 'обмена', 'обменов') ?></span>
            <span><?= esc(fmtTime($summary['last_time'])) ?></span>
          </div>
          <div class="preview"><?= esc(mbTruncate($summary['preview'] !== '' ? $summary['preview'] : '(без текста вопроса)', 160)) ?></div>
        </a>
      <?php endforeach; ?>
    <?php endif; ?>

    <h2 class="section-title">Что смотрел</h2>
    <?php if (empty($personViews)): ?>
      <div class="empty-inline">Страницы чаёв не открывал.</div>
    <?php else: ?>
      <div class="view-top">
        <?php foreach (array_slice($viewTop, 0, 5, true) as $tid => $row): ?>
          <a class="badge" href="/tea-<?= esc(rawurlencode((string) $tid)) ?>.html" target="_blank" rel="noopener"><?= esc($row['name']) ?> × <?= (int) $row['count'] ?></a>
        <?php endforeach; ?>
      </div>
      <div class="view-list">
        <?php foreach ($personViews as $v): ?>
          <div class="view-row">
            <a href="/tea-<?= esc(rawurlencode((string) ($v['teaId'] ?? ''))) ?>.html" target="_blank" rel="noopener"><?= esc($v['name'] ?? '—') ?></a>
            <span><?= esc(fmtTime($v['at'] ?? null)) ?></span>
          </div>
        <?php endforeach; ?>
      </div>
    <?php endif; ?>

  <?php elseif (empty($people)): ?>
    <div class="empty">Пользователей пока нет. Список наполняется, когда посетители открывают страницы чаёв, пишут мастеру или оформляют заказ.</div>

  <?php else: ?>
    <?php foreach ($people as $p): ?>
      <?php $isUser = ($p['kind'] ?? '') === 'user'; $oc = (int) ($p['ordersCount'] ?? 0); $cc = (int) ($p['chatsCount'] ?? 0); $vc = (int) ($p['viewsCount'] ?? 0); ?>
      <a class="conv-card" href="?tab=users&u=<?= esc($p['key'] ?? '') ?>">
        <div class="row1">
          <span><?= $isUser ? 'Telegram' . (!empty($p['username']) ? ' · @' . esc($p['username']) : '') : esc(personKindLabel($p)) ?></span>
          <span>был <?= esc(fmtTime($p['lastSeen'] ?? null)) ?></span>
        </div>
        <div class="preview"><?= esc(personTitle($p)) ?><?= (!$isUser && is_array($p['contact'] ?? null) && !empty($p['contact']['phone'])) ? ' · ' . esc($p['contact']['phone']) : '' ?></div>
        <div class="badges">
          <span class="badge <?= $oc ? '' : 'guest-visit' ?>"><?= $oc ?> <?= plural($oc, 'заказ', 'заказа', 'заказов') ?><?= !empty($p['ordersTotal']) ? ' · ' . number_format((int) $p['ordersTotal'], 0, '', ' ') . ' ₽' : '' ?></span>
          <span class="badge <?= $cc ? '' : 'guest-visit' ?>"><?= $cc ? 'писал мастеру' : 'мастеру не писал' ?></span>
          <span class="badge <?= $vc ? '' : 'guest-visit' ?>"><?= $vc ?> <?= plural($vc, 'просмотр', 'просмотра', 'просмотров') ?></span>
        </div>
      </a>
    <?php endforeach; ?>
  <?php endif; ?>

<?php elseif ($view === 'detail'):
    $dialogData = $dialogs[$selectedId];
    $dialogEntries = $dialogData['entries'];
    $guestId = $dialogData['guest_id'];
?>

  <a class="back-link" href="?tab=dialogs">← ко всем диалогам</a>

  <div class="dialog-header">
    <div class="title">
      Диалог<?= $dialogData['guest_total'] > 1 ? " · визит {$dialogData['guest_index']} из {$dialogData['guest_total']}" : '' ?>
      · обменов: <?= count($dialogEntries) ?>
    </div>
    <div class="guest-id">Гость: <?= esc($guestId) ?></div>

    <?php if ($dialogData['guest_total'] > 1): ?>
      <div class="sibling-nav">
        <?php foreach ($dialogs as $siblingId => $siblingData): ?>
          <?php if ($siblingData['guest_id'] !== $guestId) { continue; } ?>
          <?php if ($siblingId === $selectedId): ?>
            <span class="current-dialog">визит <?= $siblingData['guest_index'] ?></span>
          <?php else: ?>
            <a href="?tab=dialogs&id=<?= urlencode($siblingId) ?>">визит <?= $siblingData['guest_index'] ?> · <?= esc(fmtTime(end($siblingData['entries'])['timestamp'] ?? null)) ?></a>
          <?php endif; ?>
        <?php endforeach; ?>
      </div>
    <?php endif; ?>
  </div>

  <?php foreach ($dialogEntries as $entry): ?>
    <div class="exchange">
      <div class="meta">
        <span><?= esc(fmtTime($entry['timestamp'] ?? null)) ?></span>
        <?php if (!empty($entry['model'])): ?><span>модель: <?= esc($entry['model']) ?></span><?php endif; ?>
        <?php if (isset($entry['duration_ms'])): ?><span><?= esc($entry['duration_ms']) ?> мс</span><?php endif; ?>
        <?php $tokStr = fmtTokens($entry); if ($tokStr !== ''): ?><span>токены: <?= esc($tokStr) ?></span><?php endif; ?>
      </div>

      <?php if (isset($entry['question']) && trim((string) $entry['question']) !== ''): ?>
        <div class="msg msg--user"><?= nl2br(esc($entry['question'])) ?></div>
      <?php endif; ?>

      <?php if (isset($entry['error'])): ?>
        <div class="msg msg--error">Ошибка: <?= nl2br(esc($entry['error'])) ?></div>
      <?php elseif (isset($entry['answer'])): ?>
        <div class="msg msg--bot">
          <?= nl2br(esc($entry['answer'])) ?>
          <?php if (!empty($entry['product_ids'])): ?>
            <div class="msg__products">Товары: ID <?= esc(implode(', ', (array) $entry['product_ids'])) ?></div>
          <?php endif; ?>
          <?php if (!empty($entry['follow_up_question'])): ?>
            <div class="msg__followup">Уточняющий вопрос: «<?= esc($entry['follow_up_question']) ?>»</div>
          <?php endif; ?>
        </div>
      <?php endif; ?>
    </div>
  <?php endforeach; ?>

<?php else: ?>

  <form class="filters" method="get">
    <input type="hidden" name="tab" value="dialogs">
    <input type="text" name="q" value="<?= esc($search) ?>" placeholder="Поиск по тексту вопроса/ответа или ID гостя…">
    <label><input type="checkbox" name="errors" value="1" <?= $onlyErrors ? 'checked' : '' ?>> только с ошибками</label>
    <button class="btn" type="submit">Найти</button>
  </form>

  <?php
  $filtered = [];
  foreach ($dialogs as $dialogId => $dialogData) {
      $dialogEntries = $dialogData['entries'];
      $summary = summarizeDialog($dialogEntries);

      if ($onlyErrors && !$summary['has_error']) {
          continue;
      }

      if ($search !== '') {
          $haystack = mb_strtolower($dialogData['guest_id']);
          foreach ($dialogEntries as $e) {
              $haystack .= ' ' . mb_strtolower((string) ($e['question'] ?? ''));
              $haystack .= ' ' . mb_strtolower((string) ($e['answer'] ?? ''));
          }
          if (mb_stripos($haystack, mb_strtolower($search)) === false) {
              continue;
          }
      }

      $filtered[$dialogId] = ['summary' => $summary, 'meta' => $dialogData];
  }

  $totalFiltered = count($filtered);
  $totalPages = max(1, (int) ceil($totalFiltered / DIALOGS_PER_PAGE));
  $page = min($page, $totalPages);
  $pageSlice = array_slice($filtered, ($page - 1) * DIALOGS_PER_PAGE, DIALOGS_PER_PAGE, true);
  ?>

  <?php if (empty($pageSlice)): ?>
    <div class="empty">Ничего не найдено.</div>
  <?php else: ?>
    <?php foreach ($pageSlice as $dialogId => $row): ?>
      <?php $summary = $row['summary']; $meta = $row['meta']; ?>
      <a class="conv-card" href="?tab=dialogs&id=<?= urlencode($dialogId) ?>">
        <div class="row1">
          <span class="guest" title="Гость: <?= esc($meta['guest_id']) ?>">гость <?= esc(shortGuestId($meta['guest_id'])) ?></span>
          <span><?= esc(fmtTime($summary['last_time'])) ?></span>
        </div>
        <div class="preview"><?= esc(mbTruncate($summary['preview'] !== '' ? $summary['preview'] : '(без текста вопроса)', 160)) ?></div>
        <div class="badges">
          <span class="badge"><?= (int) $summary['count'] ?> запис<?= $summary['count'] === 1 ? 'ь' : ($summary['count'] < 5 ? 'и' : 'ей') ?></span>
          <?php if ($meta['guest_total'] > 1): ?>
            <span class="badge guest-visit">визит <?= (int) $meta['guest_index'] ?> из <?= (int) $meta['guest_total'] ?></span>
          <?php endif; ?>
          <?php if ($summary['tokens_in'] || $summary['tokens_out']): ?>
            <span class="badge">токены вх/исх: <?= (int) $summary['tokens_in'] ?>/<?= (int) $summary['tokens_out'] ?></span>
          <?php endif; ?>
          <?php if ($summary['has_error']): ?>
            <span class="badge error">⚠ есть ошибка</span>
          <?php endif; ?>
        </div>
      </a>
    <?php endforeach; ?>

    <?php if ($totalPages > 1): ?>
      <div class="pager">
        <?php for ($p = 1; $p <= $totalPages; $p++): ?>
          <?php if ($p === $page): ?>
            <span class="current"><?= $p ?></span>
          <?php else: ?>
            <a href="?<?= http_build_query(['tab' => 'dialogs', 'q' => $search, 'errors' => $onlyErrors ? 1 : null, 'page' => $p]) ?>"><?= $p ?></a>
          <?php endif; ?>
        <?php endfor; ?>
      </div>
    <?php endif; ?>
  <?php endif; ?>

<?php endif; ?>

</div>
<?php if ($tab === 'products') { echo productsScript(); } ?>
<?php if ($tab === 'orders'): ?>
<script>
// Продажа в магазине: «+ ещё товар» и живой итог.
(function () {
  var form = document.querySelector('[data-sale-form]');
  if (!form) return;
  var rows = form.querySelector('[data-sale-rows]');
  function total() {
    var sum = 0;
    rows.querySelectorAll('.sale-row').forEach(function (r) {
      var sel = r.querySelector('[data-sale-item]');
      var opt = sel.options[sel.selectedIndex];
      if (!sel.value) return;
      var own = r.querySelector('[data-sale-price]').value.replace(/\D/g, '');
      var price = own !== '' ? Number(own) : Number(opt.getAttribute('data-price') || 0);
      sum += price * Math.max(1, Number(r.querySelector('[data-sale-qty]').value) || 1);
    });
    form.querySelector('[data-sale-total]').textContent = sum.toLocaleString('ru-RU');
  }
  form.querySelector('[data-sale-add]').addEventListener('click', function () {
    var row = rows.querySelector('.sale-row').cloneNode(true);
    row.querySelector('select').value = '';
    row.querySelector('[data-sale-qty]').value = 1;
    row.querySelector('[data-sale-price]').value = '';
    rows.appendChild(row);
    total();
  });
  form.addEventListener('input', total);
  form.addEventListener('change', total);
  total();
})();
</script>
<?php endif; ?>
</body>
</html>
