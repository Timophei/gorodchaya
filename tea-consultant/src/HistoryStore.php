<?php

declare(strict_types=1);

/**
 * Файловое хранилище истории диалогов для прототипа (без базы данных).
 * Каждому conversation_id соответствует свой JSON-файл в storage/conversations.
 *
 * conversation_id хранится на стороне браузера в cookie — так фронтенд "помнит",
 * какой разговор продолжать. Сам текст переписки хранится здесь, на сервере,
 * что безопаснее и не упирается в ограничение размера cookie.
 */
final class HistoryStore
{
    private string $dir;

    public function __construct(string $dir)
    {
        $this->dir = rtrim($dir, '/');
        if (!is_dir($this->dir)) {
            mkdir($this->dir, 0770, true);
        }
    }

    public static function generateConversationId(): string
    {
        return 'c_' . bin2hex(random_bytes(12));
    }

    /**
     * Проверяет, что ID диалога имеет ожидаемый безопасный формат.
     */
    public static function isValidId(string $id): bool
    {
        return (bool) preg_match('/^c_[a-f0-9]{24}$/', $id);
    }

    private function pathFor(string $conversationId): string
    {
        // isValidId уже гарантирует безопасный набор символов, но подстрахуемся basename'ом.
        $safe = basename($conversationId);
        return $this->dir . '/' . $safe . '.json';
    }

    /**
     * Возвращает полную сохранённую историю диалога.
     *
     * @return array<int, array{role: string, content: string}>
     */
    public function load(string $conversationId): array
    {
        $path = $this->pathFor($conversationId);
        if (!is_file($path)) {
            return [];
        }

        $fh = fopen($path, 'r');
        if ($fh === false) {
            return [];
        }

        $messages = [];
        try {
            if (flock($fh, LOCK_SH)) {
                $raw = stream_get_contents($fh);
                flock($fh, LOCK_UN);
                $decoded = $raw !== false ? json_decode($raw, true) : null;
                if (is_array($decoded)) {
                    $messages = $decoded;
                }
            }
        } finally {
            fclose($fh);
        }

        return $messages;
    }

    /**
     * Возвращает последние $limit сообщений диалога (для контекста запроса).
     *
     * @return array<int, array{role: string, content: string}>
     */
    public function loadRecent(string $conversationId, int $limit): array
    {
        $messages = $this->load($conversationId);
        if (count($messages) <= $limit) {
            return $messages;
        }
        return array_slice($messages, -$limit);
    }

    /**
     * Добавляет пару "сообщение пользователя / ответ консультанта" в историю
     * и обрезает её до разумного максимума, чтобы файл не рос бесконечно.
     */
    public function appendExchange(string $conversationId, string $userMessage, string $assistantAnswer, int $maxStored = 60): void
    {
        $path = $this->pathFor($conversationId);
        $fh = fopen($path, 'c+');
        if ($fh === false) {
            return;
        }

        try {
            if (flock($fh, LOCK_EX)) {
                $raw = stream_get_contents($fh);
                $messages = [];
                if ($raw !== false && trim($raw) !== '') {
                    $decoded = json_decode($raw, true);
                    if (is_array($decoded)) {
                        $messages = $decoded;
                    }
                }

                $messages[] = ['role' => 'user', 'content' => $userMessage];
                $messages[] = ['role' => 'assistant', 'content' => $assistantAnswer];

                if (count($messages) > $maxStored) {
                    $messages = array_slice($messages, -$maxStored);
                }

                ftruncate($fh, 0);
                rewind($fh);
                fwrite($fh, json_encode($messages, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
                fflush($fh);
                flock($fh, LOCK_UN);
            }
        } finally {
            fclose($fh);
        }
    }
}
