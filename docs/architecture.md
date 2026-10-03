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
        V --> W["Цикл перебора моделей"]
        W --> X{"Проверка модели"}
        X -->|В deadModels или modelCooldowns| W
        X -->|Доступна| Y["Быстрая подмена model в начале basePayload"]

        Y --> Z["Цикл перебора ключей"]
        Z --> AA{"Проверка ключа"}
        AA -->|В deadKeys или pairCooldowns| Z
        AA -->|Доступен| AB["POST к Google AI Studio"]
    end

    subgraph GoogleResponse ["Ответ Google и обработка ошибок"]
        AB -->|Таймаут 60с / AbortSignal| AC["modelCooldowns = now + 60s -> break к следующей модели"]
        AB -->|200 OK| AD["Пайплайн SSE-стриминга в Zed"]
        AB -->|Код ошибки| AE["classifyGoogleError"]

        AE -->|404 NOT_FOUND| AF["deadModels.add -> break к следующей модели"]
        AE -->|limit: 0 ZERO_QUOTA| AG["deadModels.add -> break к следующей модели"]
        AE -->|400 / 401 / 403 AUTH| AH["deadKeys.add -> continue к следующему ключу"]
        AE -->|503 UNAVAILABLE| AI["modelCooldowns = now + 60s -> break к следующей модели"]
        AE -->|429 RPD| AJ["pairCooldowns = 00:00 UTC -> continue к следующему ключу"]
        AE -->|429 RPM| AK["pairCooldowns = now + retryDelay -> continue к следующему ключу"]
        AE -->|429 TPM| AL["Лог WARN -> continue к следующему ключу"]

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
        AM -.->|Каждые 100 записей| AO["Триггер prune_old_logs_trigger"]
        AO -.->|id <= NEW.id - 5000| AP["Удаление старых строк (буфер 5000)"]
    end

    subgraph Failure ["Исчерпание попыток"]
        W -->|Все попытки исчерпаны >= 40| AQ["HTTP 429 gateway_exhausted с подсказкой"]
    end
