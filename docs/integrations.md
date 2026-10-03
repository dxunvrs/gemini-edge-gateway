# Руководство по интеграции вне Zed IDE

Шлюз предоставляет стандартный OpenAI-совместимый интерфейс (`/v1/chat/completions` и `/v1/models`), что позволяет использовать его в любых операционных системах, терминалах, языках программирования и сторонних редакторах.

## Содержание

- [Настройки подключения](#настройки-подключения)
- [Вызовы через терминал (Windows и Linux/WSL)](#вызовы-через-терминал-windows-и-linuxwsl)
- [Python (OpenAI SDK и стандартный urllib)](#python-openai-sdk-и-стандартный-urllib)
- [Node.js (TypeScript)](#nodejs-typescript)
- [Cursor и VS Code (Continue)](#cursor-и-vs-code-continue)
- [Консольный агент Aider](#консольный-агент-aider)

## Настройки подключения

- базовый адрес (Base URL): `https://gemini-edge-gateway.your-name-in-cloudflare.workers.dev/v1`
- ключ авторизации (API Key): значение вашей переменной `AUTH_SECRET`
- поддерживаемые модели: `gemini-smart` (каскад тяжелых моделей с рассуждениями) и `gemini-lite` (каскад быстрых легковесных моделей)

## Вызовы через терминал (Windows и Linux/WSL)

При отправке JSON через консоль важно учитывать особенности экранирования кавычек и кодировки UTF-8 в различных операционных системах.

### 1. Windows (PowerShell)

В стандартном Windows PowerShell 5.1 кодировка пайплайнов по умолчанию настроена на ASCII, а командлет `Invoke-RestMethod` может искажать кириллицу. Для корректной работы на русском языке и надежной передачи JSON используйте один из двух проверенных способов:

**Способ А: через встроенный `curl.exe`**
В PowerShell символ `@` является служебным, поэтому параметр stdin для curl экранируется как `--data-binary '@-'`:

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

'{"model":"gemini-lite","messages":[{"role":"user","content":"Привет, ответь по-русски"}]}' | curl.exe -s -X POST "https://gemini-edge-gateway.your-name-in-cloudflare.workers.dev/v1/chat/completions" -H "Content-Type: application/json; charset=utf-8" -H "Authorization: Bearer ВАШ_AUTH_SECRET" -H "User-Agent: Mozilla/5.0" --data-binary '@-'
```

**Способ Б: нативный `Invoke-WebRequest` с явным UTF-8**

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$headers = @{
    "Content-Type" = "application/json; charset=utf-8"
    "Authorization" = "Bearer ВАШ_AUTH_SECRET"
    "User-Agent" = "gemini-edge-gateway-client/1.0"
}
$bodyObj = @{
    model = "gemini-lite"
    messages = @(@{ role = "user"; content = "Привет, ответь по-русски" })
}
$bodyBytes = [System.Text.Encoding]::UTF8.GetBytes(($bodyObj | ConvertTo-Json))

$resp = Invoke-WebRequest -Uri "https://gemini-edge-gateway.your-name-in-cloudflare.workers.dev/v1/chat/completions" -Method Post -Headers $headers -Body $bodyBytes -UseBasicParsing
$data = [System.Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray()) | ConvertFrom-Json
$data.choices[0].message.content
```

### 2. Linux (Bash / WSL)

В Linux / WSL экранирование в Bash выполняется через одинарные кавычки:

**Обычный запрос:**
```bash
curl -s -X POST "https://gemini-edge-gateway.your-name-in-cloudflare.workers.dev/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ВАШ_AUTH_SECRET" \
  -H "User-Agent: Mozilla/5.0" \
  -d '{
    "model": "gemini-lite",
    "messages": [
      {"role": "user", "content": "Напиши однострочник на bash для поиска файлов больше 100MB"}
    ]
  }'
```

**Потоковый запрос в реальном времени (SSE Streaming):**
Флаг `-N` (`--no-buffer`) отключает буферизацию вывода:
```bash
curl -N -s -X POST "https://gemini-edge-gateway.your-name-in-cloudflare.workers.dev/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ВАШ_AUTH_SECRET" \
  -H "User-Agent: Mozilla/5.0" \
  -d '{
    "model": "gemini-smart",
    "messages": [
      {"role": "user", "content": "Объясни устройство кольцевого буфера"}
    ],
    "stream": true
  }'
```

## Python (OpenAI SDK и стандартный urllib)

> [!note]
> При прямых HTTP-запросах к Cloudflare Workers из Python стандартный заголовок `User-Agent: Python-urllib/...` может блокироваться WAF (ошибка 403 / Error 1010). Всегда указывайте осмысленный `User-Agent`.

### Вариант А: Официальная библиотека `openai`

Установка:
```bash
pip install openai
```

Скрипт потоковой генерации:
```python
from openai import OpenAI

client = OpenAI(
    base_url="https://gemini-edge-gateway.your-name-in-cloudflare.workers.dev/v1",
    api_key="ВАШ_AUTH_SECRET"
)

stream = client.chat.completions.create(
    model="gemini-smart",
    messages=[
        {"role": "system", "content": "Ты опытный инженер-разработчик"},
        {"role": "user", "content": "Объясни устройство алгоритма Paxos простыми словами"}
    ],
    stream=True
)

for chunk in stream:
    content = chunk.choices[0].delta.content
    if content:
        print(content, end="", flush=True)
print()
```

### Вариант Б: Без внешних зависимостей (стандартный urllib)

Если сторонние библиотеки ставить нельзя, потоковый ответ легко читается на стандартном Python:

```python
import json
import urllib.request

url = "https://gemini-edge-gateway.your-name-in-cloudflare.workers.dev/v1/chat/completions"
headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer ВАШ_AUTH_SECRET",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
}
payload = {
    "model": "gemini-lite",
    "messages": [
        {"role": "user", "content": "Привет! Назови 3 быстрых факта о космосе"}
    ],
    "stream": True
}

req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")

with urllib.request.urlopen(req) as resp:
    for line in resp:
        decoded = line.decode("utf-8").strip()
        if decoded.startswith("data: ") and decoded != "data: [DONE]":
            data = json.loads(decoded[6:])
            chunk = data["choices"][0]["delta"].get("content", "")
            print(chunk, end="", flush=True)
print()
```

## Node.js (TypeScript)

Установка официального SDK:

```bash
npm install openai
```

Пример на Node.js:

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://gemini-edge-gateway.your-name-in-cloudflare.workers.dev/v1",
  apiKey: "ВАШ_AUTH_SECRET",
});

async function main() {
  const stream = await client.chat.completions.create({
    model: "gemini-smart",
    messages: [{ role: "user", content: "Привет! Сравни B-Tree и LSM-Tree" }],
    stream: true,
  });

  for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content || "");
  }
  console.log();
}

main();
```

## Cursor и VS Code (Continue)

Шлюз можно использовать в качестве основной модели в расширении Continue для VS Code или Cursor:

- откройте настройки расширения `config.json`
- добавьте блок провайдера:
```json
{
  "models": [
    {
      "title": "Gemini Smart Gateway",
      "provider": "openai",
      "model": "gemini-smart",
      "apiBase": "https://gemini-edge-gateway.your-name-in-cloudflare.workers.dev/v1",
      "apiKey": "ВАШ_AUTH_SECRET"
    }
  ]
}
```

## Консольный агент Aider

Шлюз полностью поддерживает работу терминального агента [Aider](https://aider.chat/):

```bash
export OPENAI_API_BASE="https://gemini-edge-gateway.your-name-in-cloudflare.workers.dev/v1"
export OPENAI_API_KEY="ВАШ_AUTH_SECRET"

aider --model openai/gemini-smart
```
