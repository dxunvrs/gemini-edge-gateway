# Архитектура и структура запросов Zed IDE к LLM-шлюзу

Данный документ описывает реальную структуру JSON-полезной нагрузки, генерируемой редактором **Zed IDE** в режиме **Agent / Write**, перехваченной и документированной в процессе разработки `gemini-edge-gateway`.

## Содержание

- [Корневая структура запроса (POST /v1/chat/completions)](#корневая-структура-запроса-post-v1chatcompletions)
- [Системный промпт агента Zed (role: "system")](#системный-промпт-агента-zed-role-system)
- [Схема объявления инструментов Zed (массив tools)](#схема-объявления-инструментов-zed-массив-tools)
- [Двухшаговый диалог с вызовом инструмента (Tool Calling Flow)](#двухшаговый-диалог-с-вызовом-инструмента-tool-calling-flow)
  - [Ответ ассистента с вызовом инструмента (Assistant Turn)](#ответ-ассистента-с-вызовом-инструмента-assistant-turn)
  - [Результат выполнения инструмента от Zed (Tool Response Turn)](#результат-выполнения-инструмента-от-zed-tool-response-turn)

- [Мультимодальные ответы (Чтение изображений конспектов)](#мультимодальные-ответы-чтение-изображений-конспектов)

## Корневая структура запроса (POST /v1/chat/completions)

Zed отправляет строгий OpenAI-совместимый объект со следующими корневыми ключами:

```json
{
  "model": "gemini-smart",
  "messages": [ /* История диалога и системный промпт */ ],
  "stream": true,
  "stream_options": {
    "include_usage": true
  },
  "max_completion_tokens": 65536,
  "temperature": 0.2,
  "tools": [ /* Список встроенных инструментов Zed */ ],
  "reasoning_effort": "high"
}
```

## Системный промпт агента Zed (role: "system")

Первым сообщением в массиве `messages` Zed отправляет системную инструкцию, регламентирующую поведение агента в проекте, работу с файловой системой и правилами компактности контекста:

```json
{
  "role": "system",
  "content": "You are Zed's Assistant, a helpful AI coding assistant built into the Zed editor.\nYou are capable of executing actions in the user's workspace using tools.\n\n# Tool Guidelines\n- Always prefer using specific tools over asking the user to perform manual actions.\n- When reading files: For large files, use `start_line` and `end_line` parameters.\n- When modifying files: Prefer `edit_file` with precise line diffs.\n- Do not fabricate file paths. Verify using `list_directory` or `find_path` before reading.\n- Keep your reasoning concise and strictly focused on solving the coding task.\n\n# User Rules & Project Guidelines\n- Respect custom instructions provided by the user in .rules or prompt files."
}
```

## Схема объявления инструментов Zed (массив `tools`)

Zed передает модели набор встроенных инструментов файловой системы (15+ функций). Пример реального описания инструмента `read_file`:

```json
{
  "type": "function",
  "function": {
    "name": "read_file",
    "description": "Reads the content of a file at the given path. For large files, an outline with symbol names and line numbers is returned instead of full content.",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "The relative path to the file in the workspace"
        },
        "start_line": {
          "type": "integer",
          "description": "Optional 1-based start line number to read"
        },
        "end_line": {
          "type": "integer",
          "description": "Optional 1-based end line number to read"
        }
      },
      "required": ["path"]
    }
  }
}
```

## Двухшаговый диалог с вызовом инструмента (Tool Calling Flow)

### Ответ ассистента с вызовом инструмента (Assistant Turn)

Модель решает выполнить действие (например, найти файлы конспектов). В этот момент `content` равен `null` (или пуст), а команда передается в массиве `tool_calls`:

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_find_lectures_01",
      "type": "function",
      "function": {
        "name": "find_path",
        "arguments": "{\"glob\":\"*.md\"}"
      },
      "extra_content": {
        "google": {
          "thought_signature": "skip_thought_signature_validator"
        }
      }
    }
  ]
}
```
> **Важно:** Поле `extra_content.google.thought_signature` автоматически внедряется шлюзом для обхода проверки криптографической подписи рассуждений Google Gemini 3.

### Результат выполнения инструмента от Zed (Tool Response Turn)

Zed локально на компьютере выполняет команду и присылает результат в сообщении с ролью `role: "tool"`:

```json
{
  "role": "tool",
  "tool_call_id": "call_find_lectures_01",
  "content": "itmo-notebook/matan/sem3/lection_notes/lection-1.md\nitmo-notebook/matan/sem3/lection_notes/lection-2.md\nitmo-notebook/matan/sem3/lection_notes/lection-3.md"
}
```

## Мультимодальные ответы (Чтение изображений конспектов)

Когда Zed считывает фотографии через `read_file`, он передает изображение в формате base64.

Для совместимости с Google AI API шлюз трансформирует бинарные данные инструмента в сообщение пользователя:

```json
{
  "role": "tool",
  "tool_call_id": "call_read_photo_01",
  "content": "Image loaded successfully."
},
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "Visual content from tool:"
    },
    {
      "type": "image_url",
      "image_url": {
        "url": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ..."
      }
    }
  ]
}
```
