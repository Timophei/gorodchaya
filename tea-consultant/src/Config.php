<?php

declare(strict_types=1);

/**
 * Простой загрузчик .env без внешних зависимостей.
 * Читает файл .env из корня проекта один раз и кладёт значения в статический массив,
 * не затирая уже установленные переменные окружения (getenv/putenv).
 */
final class Config
{
    private static ?array $values = null;

    public static function load(): void
    {
        if (self::$values !== null) {
            return;
        }

        self::$values = [];

        $path = dirname(__DIR__) . '/.env';
        if (!is_file($path) || !is_readable($path)) {
            return;
        }

        $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        if ($lines === false) {
            return;
        }

        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '' || str_starts_with($line, '#')) {
                continue;
            }
            if (!str_contains($line, '=')) {
                continue;
            }
            [$key, $value] = explode('=', $line, 2);
            $key = trim($key);
            $value = trim($value);

            // Снимаем окружающие кавычки, если они есть.
            if (strlen($value) >= 2) {
                $first = $value[0];
                $last = $value[strlen($value) - 1];
                if (($first === '"' && $last === '"') || ($first === "'" && $last === "'")) {
                    $value = substr($value, 1, -1);
                }
            }

            self::$values[$key] = $value;
        }
    }

    public static function get(string $key, ?string $default = null): ?string
    {
        self::load();

        // Настоящие переменные окружения (например, заданные на сервере) имеют приоритет.
        $env = getenv($key);
        if ($env !== false && $env !== '') {
            return $env;
        }

        return self::$values[$key] ?? $default;
    }

    public static function getInt(string $key, int $default): int
    {
        $value = self::get($key);
        if ($value === null || $value === '' || !is_numeric($value)) {
            return $default;
        }
        return (int) $value;
    }
}
