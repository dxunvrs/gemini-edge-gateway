import { createGeminiStreamPipeline } from "./stream.js";
import { recordSuccess } from "./analytics.js";
import { logSuccess, logWarn, logError } from "./logger.js";

const DEFAULT_GOOGLE_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MAX_SUBREQUESTS = 40;
const ATTEMPT_TIMEOUT_MS = 30000; // 30 секунд

// Настройки кулдаунов и таймзон
const COOLDOWN_503_MS = 3 * 60 * 1000; // 3 минуты при перегрузке модели
const DEFAULT_RPM_DELAY_MS = 60 * 1000; // 60 секунд по умолчанию при минутном лимите
const PACIFIC_TIMEZONE = "America/Los_Angeles";
const MIDNIGHT_BUFFER_SEC = 5 * 60; // 5 минут запаса после полуночи PT
const ONE_HOUR_MS = 60 * 60 * 1000; // 1 час для защиты от рассинхрона

// Таблицы штрафного бокса в памяти
const modelCooldowns = {};
const pairCooldowns = {};
const lastRpdUnblock = {}; // Время последнего выхода пары из суточного бана
let cachedNextMidnightPT = 0; // Кэш полуночи PT

// Вычисление точного времени следующей полуночи по Pacific Time (PT) с кэшированием
function getNextMidnightPacificTime() {
  const now = Date.now();
  if (now < cachedNextMidnightPT) {
    return cachedNextMidnightPT;
  }

  const nowDate = new Date(now);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIMEZONE,
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  });

  const parts = Object.fromEntries(dtf.formatToParts(nowDate).map((p) => [p.type, p.value]));
  const currentHour = parseInt(parts.hour, 10);
  const currentMinute = parseInt(parts.minute, 10);
  const currentSecond = parseInt(parts.second, 10);

  const secondsSinceMidnightPT = currentHour * 3600 + currentMinute * 60 + currentSecond;
  const secondsUntilMidnightPT = 86400 - secondsSinceMidnightPT;

  cachedNextMidnightPT = now + (secondsUntilMidnightPT + MIDNIGHT_BUFFER_SEC) * 1000;
  return cachedNextMidnightPT;
}

// Парсинг retryDelay от Google (например, "51s" или "51.670273123s")
function parseRetryDelayMs(retryDelayStr, defaultMs = DEFAULT_RPM_DELAY_MS) {
  if (!retryDelayStr) return defaultMs;
  const match = String(retryDelayStr).match(/([\d.]+)\s*s?/i);
  if (match) {
    const sec = parseFloat(match[1]);
    if (sec <= 60) {
      return Math.ceil(sec) * 1000;
    }
  }
  return defaultMs;
}

function normalizeReasoningEffort(effort) {
  if (!effort) return "medium";
  const e = String(effort).toLowerCase().replace(/[\s_-]+/g, "");
  if (e === "max" || e === "extrahigh" || e === "high") return "high";
  if (e === "low" || e === "minimal") return "low";
  return "medium";
}

// Анализ типа ошибки Google AI API
function classifyGoogleError(statusCode, errorObj) {
  const message = (errorObj?.message || "").toLowerCase();
  const rawDetails = JSON.stringify(errorObj?.details || []).toLowerCase();
  const allText = `${message} ${rawDetails}`;

  // Авторизация (401 / 403)
  if (statusCode === 401 || statusCode === 403 || allText.includes("api_key_invalid") || allText.includes("permission_denied")) {
    return { type: "AUTH", isDaily: false, isTpm: false, isRpm: false, is503: false };
  }

  // Серверная перегрузка (503 / 500 / UNAVAILABLE)
  if (statusCode === 503 || statusCode === 500 || errorObj?.status === "UNAVAILABLE" || allText.includes("overloaded")) {
    return { type: "UNAVAILABLE", isDaily: false, isTpm: false, isRpm: false, is503: true };
  }

  // Превышение контекста / токенов (400 или 429 TPM)
  const isTpm = allText.includes("tpm") || allText.includes("tokensperminute");
  if (statusCode === 400 && isTpm) {
    return { type: "TPM", isDaily: false, isTpm: true, isRpm: false, is503: false };
  }

  // Лимиты квот (429 / RESOURCE_EXHAUSTED)
  if (statusCode === 429 || errorObj?.status === "RESOURCE_EXHAUSTED") {
    const isDaily = allText.includes("perday") || allText.includes("per_day") || allText.includes("daily");
    if (isDaily) {
      return { type: "RPD", isDaily: true, isTpm: false, isRpm: false, is503: false };
    }
    if (isTpm) {
      return { type: "TPM", isDaily: false, isTpm: true, isRpm: false, is503: false };
    }
    return { type: "RPM", isDaily: false, isTpm: false, isRpm: true, is503: false };
  }

  return { type: "OTHER", isDaily: false, isTpm: false, isRpm: false, is503: false };
}

export async function executeStratifiedRouting(request, rawText, currentUser, cascades, activeKeys, env = null, ctx = null) {
  // Безопасно определяем модель по первым 500 символам
  const headSnippet = rawText.slice(0, 500);
  const isLite = /"model"\s*:\s*"[^"]*lite/i.test(headSnippet);
  const targetCascade = isLite ? cascades.lite : cascades.smart;

  // Заменяем неэкранированный JSON-ключ "content": null на "content": "" (исправляет 400 ошибку Google)
  let preparedPayload = rawText.replace(/(?<!\\)"content"\s*:\s*null/g, '"content":""');

  // Исправляем 400 ошибку Google при Thinking: внедряем официальный bypass-маркер thought_signature
  if (preparedPayload.includes('"tool_calls"') && !preparedPayload.includes('thought_signature')) {
    preparedPayload = preparedPayload.replace(
      /(?<!\\)("id"\s*:\s*"[^"]*"\s*,\s*"type"\s*:\s*"function")/g,
      '$1,"extra_content":{"google":{"thought_signature":"skip_thought_signature_validator"}}'
    );
  }

  const now = Date.now();
  let hadTpmError = false;
  let hadRpdError = false;
  let hadRpmError = false;
  let hadAuthError = false;
  let lastGoogleError = "";
  let attemptsCount = 0;

  // Каскадный перебор: от лучших моделей к базовым
  for (const model of targetCascade) {
    if (attemptsCount >= MAX_SUBREQUESTS) break;

    // Если вся модель во временном кулдауне (например, после 503) — пропускаем
    if (modelCooldowns[model] && modelCooldowns[model] > now) {
      continue;
    }

    // Заменяем первое вхождение неэкранированного ключа "model" в корне JSON
    const payload = preparedPayload.replace(/(?<!\\)"model"\s*:\s*"[^"]*"/, `"model":"${model}"`);

    for (const keyItem of activeKeys) {
      if (attemptsCount >= MAX_SUBREQUESTS) break;

      const pairKey = `${model}:${keyItem.id}`;

      // Проверяем кулдаун конкретной пары модель:ключ
      if (pairCooldowns[pairKey] && pairCooldowns[pairKey] > now) {
        continue;
      }

      attemptsCount++;
      const startTime = Date.now();

      try {
        const response = await fetch(DEFAULT_GOOGLE_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${keyItem.key}`,
          },
          body: payload,
          signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        });

        const durationMs = Date.now() - startTime;

        if (!response.ok) {
          let errorData = null;
          try {
            errorData = await response.json();
          } catch { }

          const errorObj = errorData?.error || {};
          const statusCode = response.status;
          const errorMsg = errorObj.message || `HTTP ${statusCode}`;
          lastGoogleError = errorMsg;

          // Классифицируем причину ошибки
          const errInfo = classifyGoogleError(statusCode, errorObj);

          // 404: Модель не найдена в OpenAI API Google — выключаем ее на 24 часа
          if (statusCode === 404) {
            modelCooldowns[model] = Date.now() + 24 * 60 * 60 * 1000;
            logWarn(model, keyItem.id, statusCode, `Model Not Found (404): ${errorMsg}`, errorData, env, ctx);
            break;
          }

          if (errInfo.type === "AUTH") {
            hadAuthError = true;
            // Блокируем невалидный ключ для всех моделей на 24 часа
            for (const m of targetCascade) {
              pairCooldowns[`${m}:${keyItem.id}`] = Date.now() + 24 * 60 * 60 * 1000;
            }
            logWarn(model, keyItem.id, statusCode, `Auth Error: ${errorMsg}`, errorData, env, ctx);
            continue;
          }

          if (errInfo.type === "UNAVAILABLE") {
            // Временный кулдаун на модель целиком
            modelCooldowns[model] = Date.now() + COOLDOWN_503_MS;
            logWarn(model, keyItem.id, statusCode, `Model Overloaded (503): ${errorMsg}`, errorData, env, ctx);
            break; // Переходим к следующей модели в каскаде
          }

          if (errInfo.type === "RPD") {
            hadRpdError = true;
            const nowMs = Date.now();
            const lastUnblock = lastRpdUnblock[pairKey] || 0;
            let unlockTime = getNextMidnightPacificTime();

            if (lastUnblock > 0 && Math.abs(nowMs - lastUnblock) < ONE_HOUR_MS) {
              unlockTime = nowMs + ONE_HOUR_MS;
            }

            pairCooldowns[pairKey] = unlockTime;
            lastRpdUnblock[pairKey] = unlockTime;
            logWarn(model, keyItem.id, statusCode, `RPD Daily Limit: ${errorMsg}`, errorData, env, ctx);
            continue;
          }

          if (errInfo.type === "TPM") {
            hadTpmError = true;
            logWarn(model, keyItem.id, statusCode, `TPM Token Limit: ${errorMsg}`, errorData, env, ctx);
            continue;
          }

          if (errInfo.type === "RPM") {
            hadRpmError = true;
            const retryInfo = (errorObj.details || []).find((d) => d["@type"]?.includes("RetryInfo"));
            const delayMs = parseRetryDelayMs(retryInfo?.retryDelay, DEFAULT_RPM_DELAY_MS);
            pairCooldowns[pairKey] = Date.now() + delayMs;
            logWarn(model, keyItem.id, statusCode, `RPM Minute Limit (${Math.round(delayMs / 1000)}s): ${errorMsg}`, errorData, env, ctx);
            continue;
          }

          // Прочие ошибки
          logWarn(model, keyItem.id, statusCode, `API Error: ${errorMsg}`, errorData, env, ctx);
          continue;
        }

        // Успех (200 OK)
        logSuccess(model, keyItem.id, durationMs, env, ctx);
        recordSuccess(model, keyItem.id, currentUser, env, ctx);

        const streamPipeline = createGeminiStreamPipeline();
        response.body.pipeTo(streamPipeline.writable).catch(() => { });

        const headers = new Headers(response.headers);
        headers.delete("content-length");
        headers.delete("content-encoding");

        return new Response(streamPipeline.readable, {
          status: response.status,
          headers,
        });

      } catch (err) {
        const isTimeout = err?.name === "TimeoutError" || err?.name === "AbortError";
        if (isTimeout) {
          modelCooldowns[model] = Date.now() + COOLDOWN_503_MS;
        }
        logWarn(model, keyItem.id, 0, isTimeout ? "Timeout (30s)" : err.message, null, env, ctx);
        continue;
      }
    }
  }

  // Человекочитаемая подсказка при полном исчерпании попыток
  let advice = `исчерпаны все попытки (${attemptsCount} запросов).`;
  let errorReason = "Exhausted all attempts";

  if (hadTpmError) {
    advice = "контекст чата слишком велик (превышен минутный лимит токенов TPM). Выполните команду `/compact` в Zed или подождите 1 минуту.";
    errorReason = "TPM Limit (Tokens/Minute)";
  } else if (hadRpdError) {
    advice = "исчерпан суточный лимит запросов (RPD) на всех ключах для доступных моделей. Сброс лимитов Google происходит в полночь по Тихоокеанскому времени (~10:00 / 11:00 по МСК).";
    errorReason = "RPD Limit (Requests/Day)";
  } else if (hadRpmError) {
    advice = "слишком частые запросы (RPM). Подождите 30-60 секунд перед повтором.";
    errorReason = "RPM Limit (Requests/Minute)";
  } else if (hadAuthError) {
    advice = "все предоставленные ключи GEMINI_KEY отклонены Google API (ошибка 401/403). Проверьте актуальность ключей в переменных Cloudflare.";
    errorReason = "Auth Error (401/403 Invalid Key)";
  } else if (lastGoogleError) {
    advice = `ошибка Google API: ${lastGoogleError}`;
    errorReason = `Google API Error: ${lastGoogleError}`;
  }

  logError(errorReason, 429, { lastGoogleError, attemptsCount }, env, ctx);

  return new Response(
    JSON.stringify({
      error: {
        message: `Gemini Edge Gateway: ${advice}`,
        type: "insufficient_quota",
        code: "gateway_exhausted",
      },
    }),
    { status: 429, headers: { "Content-Type": "application/json; charset=utf-8" } }
  );
}
