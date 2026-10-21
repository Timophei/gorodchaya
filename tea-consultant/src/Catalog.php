<?php

declare(strict_types=1);

/**
 * Загружает каталог чаёв из data/teas.json и умеет проверять ID товаров.
 * Цена и наличие в этом прототипе в каталоге не хранятся — по ТЗ они пока не нужны.
 */
final class Catalog
{
    /** @var array<int, array<string, mixed>> */
    private array $itemsById = [];

    /** @var array<int, array<string, mixed>> */
    private array $items = [];

    public function __construct(string $jsonPath)
    {
        if (!is_file($jsonPath) || !is_readable($jsonPath)) {
            throw new RuntimeException("Файл каталога не найден: {$jsonPath}");
        }

        $raw = file_get_contents($jsonPath);
        if ($raw === false) {
            throw new RuntimeException("Не удалось прочитать файл каталога: {$jsonPath}");
        }

        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            throw new RuntimeException("Файл каталога содержит некорректный JSON: {$jsonPath}");
        }

        foreach ($decoded as $item) {
            if (!is_array($item) || !isset($item['id'])) {
                continue;
            }
            $id = (int) $item['id'];
            $this->itemsById[$id] = $item;
            $this->items[] = $item;
        }
    }

    /**
     * Полный каталог в виде массива (для передачи модели).
     *
     * @return array<int, array<string, mixed>>
     */
    public function all(): array
    {
        return $this->items;
    }

    /**
     * Каталог, сериализованный в компактный JSON для контекста запроса.
     */
    public function toJson(): string
    {
        return json_encode($this->items, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '[]';
    }

    public function exists(int $id): bool
    {
        return isset($this->itemsById[$id]);
    }

    /**
     * Отфильтровывает список ID, оставляя только существующие в каталоге.
     *
     * @param array<int, mixed> $ids
     * @return array{valid: int[], invalid: int[]}
     */
    public function splitValidIds(array $ids): array
    {
        $valid = [];
        $invalid = [];

        foreach ($ids as $rawId) {
            if (!is_int($rawId) && !(is_string($rawId) && ctype_digit($rawId))) {
                $invalid[] = $rawId;
                continue;
            }
            $id = (int) $rawId;
            if ($this->exists($id)) {
                $valid[] = $id;
            } else {
                $invalid[] = $id;
            }
        }

        return ['valid' => array_values(array_unique($valid)), 'invalid' => array_values(array_unique($invalid))];
    }
}
