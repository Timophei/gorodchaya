<?php

declare(strict_types=1);

/**
 * POST /api/chat.php
 *
 * Единая точка входа: приёмник (валидация, история, rate limit)
 * + ответчик (обращение к OpenAI, проверка ID товаров, журналирование).
 *
 * Сырой ответ OpenAI наружу не передаётся — только текст, ID товаров и уточняющий вопрос.
 */

require __DIR__ . '/../../src/Config.php';
require __DIR__ . '/../../src/Catalog.php';
require __DIR__ . '/../../src/PromptLoader.php';
require __DIR__ . '/../../src/HistoryStore.php';
require __DIR__ . '/../../src/RateLimiter.php';
require __DIR__ . '/../../src/Logger.php';
require __DIR__ . '/../../src/OpenAiClient.php';

header('Content-Type: application/json; charset=utf-8');

// Не выводить PHP-варнинги/notice/deprecated в тело ответа — они ломают JSON
// на стороне фронтенда. Все ошибки уже пишутся в лог отдельно (см. Logger).
ini_set('display_errors', '0');
error_reporting(E_ALL);

// На случай, если что-то всё же попадёт в вывод (echo/var_dump и т.п. в стороннем коде) —
// буферизуем и очищаем перед отправкой JSON, чтобы ответ фронтенду оставался валидным.
ob_start();

function respond(int $httpCode, array $body): void
{
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    http_response_code($httpCode);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

$root = dirname(__DIR__, 2);
Config::load();

$logger = new Logger($root . '/logs/requests.log');

// ---------- 1. Приёмник: базовая валидация запроса ----------

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(405, ['success' => false, 'error' => 'Метод не поддерживается.']);
}

$rawBody = file_get_contents('php://input');
$payload = $rawBody !== false ? json_decode($rawBody, true) : null;

if (!is_array($payload) || !isset($payload['message']) || !is_string($payload['message'])) {
    respond(400, ['success' => false, 'error' => 'Некорректный запрос: не указано сообщение.']);
}

$maxMessageLength = Config::getInt('MAX_MESSAGE_LENGTH', 1000);
$userMessage = trim($payload['message']);

if ($userMessage === '') {
    respond(400, ['success' => false, 'error' => 'Сообщение не может быть пустым.']);
}

if (mb_strlen($userMessage) > $maxMessageLength) {
    respond(400, ['success' => false, 'error' => "Сообщение слишком длинное (максимум {$maxMessageLength} символов)."]);
}

$conversationId = null;
if (isset($payload['conversation_id']) && is_string($payload['conversation_id']) && $payload['conversation_id'] !== '') {
    if (HistoryStore::isValidId($payload['conversation_id'])) {
        $conversationId = $payload['conversation_id'];
    }
    // Если ID некорректный/подделанный — тихо генерируем новый, не роняя запрос.
}
if ($conversationId === null) {
    $conversationId = HistoryStore::generateConversationId();
}

// ---------- Ограничение частоты запросов ----------

$rateLimiter = new RateLimiter(
    $root . '/storage/ratelimit',
    Config::getInt('RATE_LIMIT_MAX_REQUESTS', 20),
    Config::getInt('RATE_LIMIT_WINDOW_SECONDS', 300)
);

$clientIp = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
if (!$rateLimiter->allow($clientIp)) {
    $logger->log([
        'conversation_id' => $conversationId,
        'error' => 'rate_limit_exceeded',
        'ip' => $clientIp,
    ]);
    respond(429, ['success' => false, 'error' => 'Слишком много запросов. Попробуйте, пожалуйста, через пару минут.']);
}

// ---------- Загрузка каталога, инструкции и истории ----------

try {
    $catalog = new Catalog($root . '/data/teas.json');
    $baseInstructions = PromptLoader::load($root . '/prompts/tea-master.txt');
} catch (Throwable $e) {
    $logger->log(['conversation_id' => $conversationId, 'error' => 'startup_error: ' . $e->getMessage()]);
    respond(500, ['success' => false, 'error' => 'Консультант временно недоступен. Попробуйте позже.']);
}

$historyLimit = Config::getInt('HISTORY_MESSAGE_LIMIT', 15);
$historyStore = new HistoryStore($root . '/storage/conversations');
$history = $historyStore->loadRecent($conversationId, $historyLimit);

// Инструкция + каталог — неизменная часть в начале контекста (для эффективного prompt caching).
$instructions = $baseInstructions
    . "\n\n---\nКаталог товаров (используй только эти данные, JSON):\n"
    . $catalog->toJson();

// ---------- 2. Ответчик: обращение к OpenAI ----------

$apiKey = Config::get('OPENAI_API_KEY', '');
if ($apiKey === '' || $apiKey === null) {
    $logger->log(['conversation_id' => $conversationId, 'error' => 'missing_api_key']);
    respond(500, ['success' => false, 'error' => 'Консультант временно недоступен. Попробуйте позже.']);
}

$model = Config::get('OPENAI_MODEL', 'gpt-5.6-terra');
$projectId = Config::get('OPENAI_PROJECT_ID');
$timeout = Config::getInt('OPENAI_TIMEOUT_SECONDS', 30);

$client = new OpenAiClient($apiKey, (string) $model, $projectId, $timeout);

$startedAt = microtime(true);

try {
    $result = $client->chat($instructions, $history, $userMessage);
} catch (OpenAiException $e) {
    $logger->log([
        'conversation_id' => $conversationId,
        'question' => $userMessage,
        'model' => $model,
        'error' => $e->getKind() . ': ' . $e->getMessage(),
        'duration_ms' => (int) round((microtime(true) - $startedAt) * 1000),
    ]);
    respond(502, ['success' => false, 'error' => 'Не удалось получить ответ от консультанта. Попробуйте, пожалуйста, ещё раз.']);
}

$durationMs = (int) round((microtime(true) - $startedAt) * 1000);

// ---------- Проверка ID товаров по каталогу ----------

$idCheck = $catalog->splitValidIds($result['product_ids']);
if (!empty($idCheck['invalid'])) {
    $logger->log([
        'conversation_id' => $conversationId,
        'error' => 'invalid_product_ids',
        'invalid_ids' => $idCheck['invalid'],
    ]);
}

$followUp = is_string($result['follow_up_question']) && trim($result['follow_up_question']) !== ''
    ? $result['follow_up_question']
    : null;

// ---------- Сохранение истории ----------

$historyStore->appendExchange($conversationId, $userMessage, $result['answer']);

// ---------- Журналирование ----------

$logger->log([
    'conversation_id' => $conversationId,
    'question' => $userMessage,
    'answer' => $result['answer'],
    'follow_up_question' => $followUp,
    'product_ids' => $idCheck['valid'],
    'invalid_product_ids' => $idCheck['invalid'],
    'model' => $result['raw_model'],
    'input_tokens' => $result['usage']['input_tokens'],
    'cached_input_tokens' => $result['usage']['cached_input_tokens'],
    'output_tokens' => $result['usage']['output_tokens'],
    'duration_ms' => $durationMs,
]);

// ---------- Ответ фронтенду ----------

respond(200, [
    'success' => true,
    'conversation_id' => $conversationId,
    'answer' => $result['answer'],
    'product_ids' => $idCheck['valid'],
    'follow_up_question' => $followUp,
]);
