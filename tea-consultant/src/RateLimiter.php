<?php

declare(strict_types=1);

/**
 * Простое ограничение частоты запросов на файлах — без Redis и БД.
 * Скользящее окно: не более $maxRequests запросов за $windowSeconds на один идентификатор
 * (по умолчанию — IP-адрес).
 */
final class RateLimiter
{
    private string $dir;
    private int $maxRequests;
    private int $windowSeconds;

    public function __construct(string $dir, int $maxRequests, int $windowSeconds)
    {
        $this->dir = rtrim($dir, '/');
        if (!is_dir($this->dir)) {
            mkdir($this->dir, 0770, true);
        }
        $this->maxRequests = $maxRequests;
        $this->windowSeconds = $windowSeconds;
    }

    /**
     * Возвращает true, если запрос разрешён (и регистрирует его),
     * либо false, если лимит превышен.
     */
    public function allow(string $identifier): bool
    {
        $safeName = hash('sha256', $identifier);
        $path = $this->dir . '/' . $safeName . '.json';

        $fh = fopen($path, 'c+');
        if ($fh === false) {
            // Если не можем работать с файлом — не блокируем пользователя.
            return true;
        }

        $allowed = true;

        try {
            if (flock($fh, LOCK_EX)) {
                $raw = stream_get_contents($fh);
                $timestamps = [];
                if ($raw !== false && trim($raw) !== '') {
                    $decoded = json_decode($raw, true);
                    if (is_array($decoded)) {
                        $timestamps = $decoded;
                    }
                }

                $now = time();
                $windowStart = $now - $this->windowSeconds;
                $timestamps = array_values(array_filter($timestamps, static fn ($ts) => $ts >= $windowStart));

                if (count($timestamps) >= $this->maxRequests) {
                    $allowed = false;
                } else {
                    $timestamps[] = $now;
                }

                ftruncate($fh, 0);
                rewind($fh);
                fwrite($fh, json_encode($timestamps));
                fflush($fh);
                flock($fh, LOCK_UN);
            }
        } finally {
            fclose($fh);
        }

        return $allowed;
    }
}
