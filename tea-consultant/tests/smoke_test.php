<?php

declare(strict_types=1);

/**
 * Лёгкий smoke-тест без обращения к сети/OpenAI.
 * Проверяет каталог, историю диалога, rate limiter и конфиг.
 * Запуск: php tests/smoke_test.php
 */

require __DIR__ . '/../src/Config.php';
require __DIR__ . '/../src/Catalog.php';
require __DIR__ . '/../src/PromptLoader.php';
require __DIR__ . '/../src/HistoryStore.php';
require __DIR__ . '/../src/RateLimiter.php';
require __DIR__ . '/../src/Logger.php';

$failures = 0;

function check(string $name, bool $condition): void
{
    global $failures;
    echo ($condition ? "[OK]   " : "[FAIL] ") . $name . PHP_EOL;
    if (!$condition) {
        $failures++;
    }
}

$root = dirname(__DIR__);
$tmp = sys_get_temp_dir() . '/tea_smoke_' . bin2hex(random_bytes(4));
mkdir($tmp, 0770, true);

// --- Catalog ---
$catalog = new Catalog($root . '/data/teas.json');
check('каталог загрузился и не пуст', count($catalog->all()) >= 10);
check('товар 101 существует', $catalog->exists(101));
check('товар 999999 не существует', !$catalog->exists(999999));

$split = $catalog->splitValidIds([101, 102, 999999]);
check('splitValidIds отделяет валидные', $split['valid'] === [101, 102]);
check('splitValidIds отделяет невалидные', $split['invalid'] === [999999]);

// --- PromptLoader ---
$instructions = PromptLoader::load($root . '/prompts/tea-master.txt');
check('инструкция консультанта не пустая', strlen($instructions) > 50);

// --- HistoryStore ---
$historyDir = $tmp . '/conversations';
$history = new HistoryStore($historyDir);
$cid = HistoryStore::generateConversationId();
check('сгенерированный ID проходит валидацию формата', HistoryStore::isValidId($cid));
check('поддельный ID не проходит валидацию', !HistoryStore::isValidId('c_hacked'));

$history->appendExchange($cid, 'Привет', 'Здравствуйте!');
$history->appendExchange($cid, 'Хочу вечерний чай', 'Рекомендую Габа Алишань.');
$loaded = $history->loadRecent($cid, 15);
check('история хранит 4 сообщения (2 обмена)', count($loaded) === 4);
check('первое сообщение от пользователя', $loaded[0]['role'] === 'user' && $loaded[0]['content'] === 'Привет');
check('история для нового ID пустая', $history->loadRecent(HistoryStore::generateConversationId(), 15) === []);

// --- RateLimiter ---
$rl = new RateLimiter($tmp . '/ratelimit', 3, 60);
$ip = '127.0.0.1';
check('запрос 1 разрешён', $rl->allow($ip));
check('запрос 2 разрешён', $rl->allow($ip));
check('запрос 3 разрешён', $rl->allow($ip));
check('запрос 4 отклонён (лимит 3)', !$rl->allow($ip));

// --- Logger ---
$logPath = $tmp . '/requests.log';
$logger = new Logger($logPath);
$logger->log(['conversation_id' => $cid, 'question' => 'тест']);
check('лог-файл создан и содержит запись', is_file($logPath) && str_contains(file_get_contents($logPath), $cid));

// --- Config ---
// Config сам ищет .env в корне проекта — здесь просто проверим дефолты через getInt/get.
Config::load();
check('Config::getInt возвращает дефолт, если ключа нет', Config::getInt('SOME_UNKNOWN_KEY_XYZ', 42) === 42);

// --- Итог ---
echo PHP_EOL;
if ($failures === 0) {
    echo "Все проверки пройдены успешно." . PHP_EOL;
    exit(0);
}

echo "Провалено проверок: {$failures}" . PHP_EOL;
exit(1);
