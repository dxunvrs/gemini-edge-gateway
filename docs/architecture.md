# Архитектура и логика работы шлюза

В данном документе представлена подробная схема работы Gemini Edge Gateway, включая алгоритм проверки и валидации ключей, двухзонную обработку тела запроса (Two-Zone Split), ротацию каскадов, единый источник состояния матрицы `matrix_state` и сохранение логов в базу данных SQLite D1.

## Схема архитектуры

```mermaid
flowchart TD
    subgraph Client ["Клиент и входная точка"]
        A["Zed IDE / cURL / Python SDK"] -->|POST /v1/chat/completions| B["src/index.js"]
        B --> C{"Проверка авторизации"}
        C -->|Не совпал AUTH_SECRET| C1["401 Unauthorized"]
        C -->|Успех| D["Чтение тела rawBody"]
    end

    subgraph Discovery ["Валидация ключей и кэширование (discovery.js)"]
        D --> E["getDiscoveryData"]
        E --> F[("D1: таблица keys_cache")]
        F -->|Проверка возраста кэша < 24ч| G["Сверка пула ключей"]

        G -->|Есть в кэше| H["Кэшированные статусы VALID / INVALID"]
        G -->|Новые ключи: пачка до 40 шт| I["Сетевая проверка через GET /models"]
        G -->|Хвост свыше 40 шт| J["Временный статус UNCHECKED (?)"]

        I -->|Запись проверенной пачки| F

        J -.->|hasMoreUnchecked: true| K["Дашборд: запрос следующей пачки"]
        K -.->|GET /api/stats?validate_next=true| E

        H --> L["Пул доступных ключей activeKeys"]
        I --> L
        J -->|Фоллбэк в чате| L
    end

    subgraph Sanitizer ["Двухзонная обработка тела (Two-Zone Split)"]
        L --> M["prepareSanitizedTemplate(rawBody)"]
        M --> N{"Поиск первого вхождения image_url"}
        N -->|Найден индекс| O["Разделение: metaZone и dataZone"]
        N -->|Не найден| P["metaZone = весь текст, dataZone = пусто"]

        O --> Q["Обработка metaZone: content:null -> пустая строка"]
        P --> Q
        Q --> R["Внедрение thought_signature во все tool_calls"]
        R --> S["Нормализация reasoning_effort: minimal/max -> low/high"]
        S --> T["Обработка dataZone: замена role: tool -> user для изображений"]
        T --> U["Склейка чистого шаблона basePayload"]
    end

    subgraph Router ["Каскадная маршрутизация (router.js)"]
        U --> V["Выбор каскада: smart/lite"]
        V --> V1["ensureDeadState: чтение matrix_state с JIT-фильтром RPD"]
        V1 --> W["Цикл перебора моделей"]
        W --> X{"Проверка модели"}
        X -->|В deadModels или modelCooldowns| W
        X -->|Доступна| Y["Быстрая подмена model в начале basePayload"]

        Y --> Z["Цикл перебора ключей"]
        Z --> AA{"Проверка ключа"}
        AA -->|В deadKeys или pairCooldowns| Z
        AA -->|Доступен| AB["POST к Google AI Studio"]
    end

    subgraph GoogleResponse ["Ответ Google и обработка ошибок"]
        AB -->|Таймаут 60с / AbortSignal| AC["modelCooldowns = now + 5 min -> matrix_state: TIMEOUT -> break к следующей модели (замораживаем всю модель на 5 минут)"]
        AB -->|200 OK| AD["Пайплайн SSE-стриминга в Zed"]
        AB -->|Код ошибки| AE["classifyGoogleError"]

        AE -->|404 NOT_FOUND| AF["deadModels.set(404) -> matrix_state: 404 -> break к следующей модели"]
        AE -->|limit: 0 ZERO_QUOTA| AG["deadModels.set(limit: 0) -> matrix_state: limit: 0 -> break к следующей модели"]
        AE -->|400 / 401 / 403 AUTH| AH["deadKeys.add -> matrix_state: KEY_ERR -> keys_cache: is_valid=0 -> continue к ключу"]
        AE -->|503 UNAVAILABLE| AI["modelCooldowns = now + 10s -> matrix_state: 503 -> break к следующей модели"]
        AE -->|429 RPD| AJ["pairCooldowns = 00:00 UTC (или 01:01 UTC) -> matrix_state: RPD -> continue к ключу"]
        AE -->|429 RPM| AK["pairCooldowns = now + retryDelay -> matrix_state: RPM -> continue к ключу"]
        AE -->|429 TPM| AL["Лог WARN -> matrix_state: TPM -> continue к ключу"]

        AF --> W
        AG --> W
        AH --> Z
        AI --> W
        AJ --> Z
        AK --> Z
        AL --> Z
        AC --> W
    end

    subgraph Storage ["Хранилище Cloudflare D1"]
        AD --> AM[("D1: таблица logs")]
        AD --> AN[("D1: таблица stats_kv")]
        AD --> AR[("D1: таблица matrix_state (Source of Truth)")]
        AE -.->|Запись статуса ячейки| AR
        AC -.->|Запись таймаута ячейки| AR
        AM -.->|Каждые 100 записей| AO["Триггер prune_old_logs_trigger"]
        AO -.->|id <= NEW.id - 5000| AP["Удаление старых строк (буфер 5000)"]
    end

    subgraph Failure ["Исчерпание попыток"]
        W -->|Все попытки исчерпаны >= 40| AQ["HTTP 429 gateway_exhausted с подсказкой"]
    end
```

## Просмотр логов шлюза

### Веб-дашборд

Базовый мониторинг логов и матрица статусов доступны прямо на главной странице воркера в браузере:
`https://gemini-edge-gateway.{ваш_поддомен}.workers.dev/`

Здесь выводятся события в реальном времени, время ответа (RTT), задействованные модели, идентификаторы ключей и HTTP-статусы.

### Консоль Cloudflare D1 для полного анализа ошибок

Если вам требуются полные дампы ответов Google API (содержимое поля `details`, полные тексты сообщений об ошибках, метрики квот и заголовки), вы можете выполнить прямой SQL-запрос в веб-консоли базы данных Cloudflare D1:

- перейдите в [Cloudflare Dashboard](https://dash.cloudflare.com/)
- в левом боковом меню перейдите: **Storage & Databases** -> **D1 SQL Database**
- выберите базу данных `gemini-gateway-db` (ссылка формата `https://dash.cloudflare.com/{account_id}/workers/d1/databases/{database_id}/console`)
- перейдите на вкладку **Console**

Выполните SQL-запрос для получения последних 100 записей с полным текстом ошибок:

```sql
SELECT timestamp, level, message, model, key_id, status, duration_ms, details
FROM logs
ORDER BY timestamp DESC
LIMIT 100;
```

Колонка `details` содержит оригинальный JSON-ответ с подробностями ошибки от Google AI Studio (объекты `QuotaFailure`, ссылки `Help`, поля `retryDelay` и параметры лимитов).
