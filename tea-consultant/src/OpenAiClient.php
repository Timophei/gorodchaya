<?php

declare(strict_types=1);

/**
 * "Ответчик": обращается к OpenAI Responses API со structured outputs (JSON Schema)
 * и возвращает уже разобранную структуру ответа консультанта + данные о расходе токенов.
 *
 * ВАЖНО: поля запроса/ответа соответствуют документации Responses API на момент
 * написания кода (структурированный вывод через text.format = json_schema,
 * системный контекст через instructions, история/новое сообщение через input).
 * Перед боевым запуском сверьте эти поля с актуальной документацией OpenAI
 * и проверьте, что указанная в .env модель (OPENAI_MODEL) действительно доступна
 * вашему проекту/ключу.
 */
final class OpenAiClient
{
    private const API_URL = 'https://api.openai.com/v1/responses';

    private string $apiKey;
    private string $model;
    private ?string $projectId;
    private int $timeoutSeconds;

    public function __construct(string $apiKey, string $model, ?string $projectId, int $timeoutSeconds)
    {
        $this->apiKey = $apiKey;
        $this->model = $model;
        $this->projectId = $projectId;
        $this->timeoutSeconds = $timeoutSeconds;
    }

    private static function responseSchema(): array
    {
        return [
            'type' => 'object',
            'properties' => [
                'answer' => ['type' => 'string'],
                'product_ids' => [
                    'type' => 'array',
                    'items' => ['type' => 'integer'],
                ],
                'follow_up_question' => ['type' => ['string', 'null']],
            ],
            'required' => ['answer', 'product_ids', 'follow_up_question'],
            'additionalProperties' => false,
        ];
    }

    /**
     * @param string $instructions Неизменная инструкция консультанта + каталог (в начале контекста).
     * @param array<int, array{role: string, content: string}> $history История диалога (последние N сообщений).
     * @param string $userMessage Новое сообщение пользователя.
     *
     * @return array{
     *   answer: string,
     *   product_ids: array<int, mixed>,
     *   follow_up_question: ?string,
     *   usage: array{input_tokens: int, cached_input_tokens: int, output_tokens: int},
     *   raw_model: string
     * }
     *
     * @throws OpenAiException
     */
    public function chat(string $instructions, array $history, string $userMessage): array
    {
        $input = [];
        foreach ($history as $turn) {
            $role = $turn['role'] === 'assistant' ? 'assistant' : 'user';
            $input[] = [
                'role' => $role,
                'content' => (string) $turn['content'],
            ];
        }
        $input[] = ['role' => 'user', 'content' => $userMessage];

        $payload = [
            'model' => $this->model,
            'instructions' => $instructions,
            'input' => $input,
            'text' => [
                'format' => [
                    'type' => 'json_schema',
                    'name' => 'tea_recommendation',
                    'schema' => self::responseSchema(),
                    'strict' => true,
                ],
            ],
        ];

        $headers = [
            'Content-Type: application/json',
            'Authorization: Bearer ' . $this->apiKey,
        ];
        if ($this->projectId) {
            $headers[] = 'OpenAI-Project: ' . $this->projectId;
        }

        $ch = curl_init(self::API_URL);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            CURLOPT_TIMEOUT => $this->timeoutSeconds,
            CURLOPT_CONNECTTIMEOUT => min(10, $this->timeoutSeconds),
        ]);

        $rawResponse = curl_exec($ch);
        $curlErrno = curl_errno($ch);
        $curlError = curl_error($ch);
        $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        // curl_close() стал no-op с PHP 8.0 и помечен deprecated в PHP 8.5 —
        // вызывать не нужно, дескриптор освобождается сборщиком мусора сам.

        if ($curlErrno === CURLE_OPERATION_TIMEOUTED) {
            throw new OpenAiException('timeout', 'Превышено время ожидания ответа от OpenAI.');
        }
        if ($rawResponse === false || $curlErrno !== 0) {
            throw new OpenAiException('network_error', 'Ошибка сети при обращении к OpenAI: ' . $curlError);
        }

        $decoded = json_decode($rawResponse, true);
        if (!is_array($decoded)) {
            throw new OpenAiException('bad_response', 'OpenAI вернул нераспознаваемый ответ.');
        }

        if ($httpCode < 200 || $httpCode >= 300) {
            $apiMessage = $decoded['error']['message'] ?? ('HTTP ' . $httpCode);
            throw new OpenAiException('api_error', 'Ошибка OpenAI API: ' . $apiMessage);
        }

        $structured = $this->extractStructuredContent($decoded);
        if ($structured === null) {
            throw new OpenAiException('parse_error', 'Не удалось извлечь структурированный ответ из результата OpenAI.');
        }

        $usage = $decoded['usage'] ?? [];

        return [
            'answer' => (string) ($structured['answer'] ?? ''),
            'product_ids' => is_array($structured['product_ids'] ?? null) ? $structured['product_ids'] : [],
            'follow_up_question' => $structured['follow_up_question'] ?? null,
            'usage' => [
                'input_tokens' => (int) ($usage['input_tokens'] ?? 0),
                'cached_input_tokens' => (int) ($usage['input_tokens_details']['cached_tokens'] ?? 0),
                'output_tokens' => (int) ($usage['output_tokens'] ?? 0),
            ],
            'raw_model' => (string) ($decoded['model'] ?? $this->model),
        ];
    }

    /**
     * Достаёт JSON-текст структурированного ответа из тела Responses API
     * и декодирует его в массив.
     *
     * @param array<string, mixed> $decoded
     * @return array<string, mixed>|null
     */
    private function extractStructuredContent(array $decoded): ?array
    {
        // Некоторые SDK добавляют удобное поле output_text — используем его, если оно есть.
        if (isset($decoded['output_text']) && is_string($decoded['output_text'])) {
            $parsed = json_decode($decoded['output_text'], true);
            if (is_array($parsed)) {
                return $parsed;
            }
        }

        $output = $decoded['output'] ?? null;
        if (!is_array($output)) {
            return null;
        }

        foreach ($output as $item) {
            if (!is_array($item) || ($item['type'] ?? null) !== 'message') {
                continue;
            }
            $content = $item['content'] ?? [];
            if (!is_array($content)) {
                continue;
            }
            foreach ($content as $part) {
                if (!is_array($part)) {
                    continue;
                }
                $type = $part['type'] ?? null;
                if (($type === 'output_text' || $type === 'text') && isset($part['text'])) {
                    $parsed = json_decode((string) $part['text'], true);
                    if (is_array($parsed)) {
                        return $parsed;
                    }
                }
            }
        }

        return null;
    }
}

final class OpenAiException extends RuntimeException
{
    private string $kind;

    public function __construct(string $kind, string $message)
    {
        parent::__construct($message);
        $this->kind = $kind;
    }

    public function getKind(): string
    {
        return $this->kind;
    }
}
