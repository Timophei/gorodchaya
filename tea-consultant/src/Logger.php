<?php

declare(strict_types=1);

/**
 * Простое журналирование в файл (по одной JSON-строке на запись — JSON Lines).
 * Пригодно для последующей выгрузки и разбора качества рекомендаций.
 */
final class Logger
{
    private string $path;

    public function __construct(string $path)
    {
        $this->path = $path;
        $dir = dirname($path);
        if (!is_dir($dir)) {
            mkdir($dir, 0770, true);
        }
    }

    /**
     * @param array<string, mixed> $entry
     */
    public function log(array $entry): void
    {
        $entry = array_merge(['timestamp' => date('c')], $entry);

        $line = json_encode($entry, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($line === false) {
            return;
        }

        $fh = fopen($this->path, 'a');
        if ($fh === false) {
            return;
        }
        try {
            if (flock($fh, LOCK_EX)) {
                fwrite($fh, $line . PHP_EOL);
                flock($fh, LOCK_UN);
            }
        } finally {
            fclose($fh);
        }
    }
}
