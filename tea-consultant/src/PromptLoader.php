<?php

declare(strict_types=1);

/**
 * Загружает системную инструкцию консультанта из текстового файла.
 * Файл редактируется отдельно от кода (prompts/tea-master.txt).
 */
final class PromptLoader
{
    public static function load(string $path): string
    {
        if (!is_file($path) || !is_readable($path)) {
            throw new RuntimeException("Файл инструкции консультанта не найден: {$path}");
        }

        $content = file_get_contents($path);
        if ($content === false || trim($content) === '') {
            throw new RuntimeException("Файл инструкции консультанта пуст или не читается: {$path}");
        }

        return trim($content);
    }
}
