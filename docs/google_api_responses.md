# Спецификация ответов Google Generative Language API (OpenAI-compatible Endpoint)

Документ содержит реальные эталонные дампы JSON-ответов от эндпоинта:
`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`
полученные в ходе тестирования и отладки `gemini-edge-gateway`.

---

## 400 Invalid Argument: Неправильный запрос

Возникает при отправке некорректного запроса.

```json
[{
  "error": {
    "code": 400,
    "message": "Invalid JSON payload received. Unexpected token.\n{model:gemini-3.5-flash,mes\n       ^",
    "status": "INVALID_ARGUMENT"
  }
}
]
```

## 400 Invalid Argument: Некорректный ключ

Возникает при отправке запроса с некорректным ключом.

```json
[{
  "error": {
    "code": 400,
    "message": "Please pass a valid API key",
    "status": "INVALID_ARGUMENT"
  }
}
]
```

## 404 Not Found: Несуществующая модель

Возникает при запросе к модели, которой нет в реестре Google.

```json
{
  "error": {
    "code": 404,
    "message": "models/gemini-999-nonexistent is not found for API version v1main, or is not supported for generateContent. Call ModelService.ListModels to see the list of available models and their supported methods.",
    "status": "NOT_FOUND"
  }
}
```

---

## 404 Not Found: Устаревшая модель (Deprecated)

Возникает при обращении к моделям предыдущих поколений (например, `gemini-2.5-flash`), отключенным для новых пользователей.

```json
{
  "error": {
    "code": 404,
    "message": "This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features and improvements. We recommend you to use the Interactions API (https://ai.google.dev/gemini-api/docs/get-started).",
    "status": "NOT_FOUND"
  }
}
```

---

## 429 Resource Exhausted: Pro-модель без квоты на бесплатном тарифе (`limit: 0`)

Возникает при попытке вызвать модели класса Pro (например, `gemini-3.1-pro`) с бесплатным API-ключом.

```json
{
  "error": {
    "code": 429,
    "message": "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro\nPlease retry in 6h43m47.450277261s.",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.Help",
        "links": [
          {
            "description": "Learn more about Gemini API quotas",
            "url": "https://ai.google.dev/gemini-api/docs/rate-limits"
          }
        ]
      },
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        "violations": [
          {
            "quotaMetric": "generativelanguage.googleapis.com/generate_content_free_tier_input_token_count",
            "quotaId": "GenerateContentInputTokensPerModelPerDay-FreeTier",
            "quotaDimensions": {
              "location": "global",
              "model": "gemini-3.1-pro"
            }
          },
          {
            "quotaMetric": "generativelanguage.googleapis.com/generate_content_free_tier_input_token_count",
            "quotaId": "GenerateContentInputTokensPerModelPerMinute-FreeTier",
            "quotaDimensions": {
              "model": "gemini-3.1-pro",
              "location": "global"
            }
          },
          {
            "quotaMetric": "generativelanguage.googleapis.com/generate_content_free_tier_requests",
            "quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
            "quotaDimensions": {
              "model": "gemini-3.1-pro",
              "location": "global"
            }
          },
          {
            "quotaMetric": "generativelanguage.googleapis.com/generate_content_free_tier_requests",
            "quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
            "quotaDimensions": {
              "location": "global",
              "model": "gemini-3.1-pro"
            }
          }
        ]
      },
      {
        "@type": "type.googleapis.com/google.rpc.RetryInfo",
        "retryDelay": "24227s"
      }
    ]
  }
}
```

---

## 429 Resource Exhausted: Превышение лимита токенов в минуту (TPM Limit)

Возникает при отправке тела запроса больше 250 000 токенов за 1 минуту.

```json
{
  "error": {
    "code": 429,
    "message": "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000, model: gemini-3.5-flash\nPlease retry in 46.401471396s.",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.Help",
        "links": [
          {
            "description": "Learn more about Gemini API quotas",
            "url": "https://ai.google.dev/gemini-api/docs/rate-limits"
          }
        ]
      },
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        "violations": [
          {
            "quotaMetric": "generativelanguage.googleapis.com/generate_content_free_tier_input_token_count",
            "quotaId": "GenerateContentInputTokensPerModelPerMinute-FreeTier",
            "quotaDimensions": {
              "location": "global",
              "model": "gemini-3.5-flash"
            },
            "quotaValue": "250000"
          }
        ]
      },
      {
        "@type": "type.googleapis.com/google.rpc.RetryInfo",
        "retryDelay": "46s"
      }
    ]
  }
}
```

---

## 429 Resource Exhausted: Превышение запросов в минуту (RPM Limit)

Возникает при превышении 5 запросов в минуту на одну пару `(модель, ключ)`.

```json
{
  "error": {
    "code": 429,
    "message": "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model: gemini-3.5-flash\nPlease retry in 30.467058293s.",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.Help",
        "links": [
          {
            "description": "Learn more about Gemini API quotas",
            "url": "https://ai.google.dev/gemini-api/docs/rate-limits"
          }
        ]
      },
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        "violations": [
          {
            "quotaMetric": "generativelanguage.googleapis.com/generate_content_free_tier_requests",
            "quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
            "quotaDimensions": {
              "location": "global",
              "model": "gemini-3.5-flash"
            },
            "quotaValue": "5"
          }
        ]
      },
      {
        "@type": "type.googleapis.com/google.rpc.RetryInfo",
        "retryDelay": "30s"
      }
    ]
  }
}
```

---

## 429 Resource Exhausted: Превышение суточного лимита (RPD Daily Limit)

Возникает при исчерпании 20 запросов в день на пару `(модель, ключ)`. Кулдаун длится до полуночи Pacific Time (~10:00-11:00 МСК).

> [!note]
> В официальной документации Google указано:
> > *"Requests per day (RPD) quotas reset at midnight Pacific time."*
>
> Из этой формулировки вроде бы очевидно, что сброс происходит в полночь по Тихоокеанскому времени (10:00 / 11:00 по МСК).
>
> Однако по полю `RetryInfo` (в частности, значению `retryDelay` и текстовым сообщениям `Please retry in Xh Ym Zs`) можно убедитья, что серверная инфраструктура Google Cloud (OnePlatform / Cloud Quotas) всё-таки производит обнуление счетчиков по **всемирному координированному времени — ровно в 00:00:00 UTC** (~ **03:00:00 мск** (**UTC+3**) и не зависит от времени года, что упрощает логику работы кода).
>
> **Практический вывод для шлюзов и балансировщиков:**
> Настройку кулдаунов и таймеров обратного отсчета суточных лимитов следует привязывать к **`00:00 UTC`**. Использование Тихоокеанского времени (PT) привело бы к искусственной блокировке ключей на лишние 7 часов, тогда как Google готов принимать трафик уже с 03:00 МСК.

```json
{
  "error": {
    "code": 429,
    "message": "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.5-flash\nPlease retry in 6h39m37.426631617s.",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.Help",
        "links": [
          {
            "description": "Learn more about Gemini API quotas",
            "url": "https://ai.google.dev/gemini-api/docs/rate-limits"
          }
        ]
      },
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        "violations": [
          {
            "quotaMetric": "generativelanguage.googleapis.com/generate_content_free_tier_requests",
            "quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
            "quotaDimensions": {
              "location": "global",
              "model": "gemini-3.5-flash"
            },
            "quotaValue": "20"
          }
        ]
      },
      {
        "@type": "type.googleapis.com/google.rpc.RetryInfo",
        "retryDelay": "23977s"
      }
    ]
  }
}
```

---

## 400 Invalid Argument: Невалидный API-ключ (Invalid Key)

Особенность Google API: возвращается статус HTTP 400 (вместо привычного 401).

```json
{
  "error": {
    "code": 400,
    "message": "API key not valid. Please pass a valid API key.",
    "status": "INVALID_ARGUMENT",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "API_KEY_INVALID",
        "domain": "googleapis.com",
        "metadata": {
          "service": "generativelanguage.googleapis.com"
        }
      }
    ]
  }
}
```

---

## 400 Invalid Argument: Изображение внутри ответа инструмента (`image_url` в `role: tool`)

Возникает при мультимодальном ответе инструмента (например, когда Zed считывает изображение конспекта через `read_file`).

```json
{
  "error": {
    "code": 400,
    "message": "Invalid content part type: image_url",
    "status": "INVALID_ARGUMENT"
  }
}
```

---

## 503 Service Unavailable: Модель перегружена (Model Overloaded)

Возникает при временном исчерпании серверных мощностей Google AI Studio.

```json
{
  "error": {
    "code": 503,
    "message": "This model is currently experiencing high demand. Please try again later.",
    "status": "UNAVAILABLE"
  }
}
```
