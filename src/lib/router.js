import { createGeminiStreamPipeline } from "./stream.js";
import { recordSuccess } from "./analytics.js";
import { log } from "./logger.js";

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

function splitIntoGroups(array, maxGroups) {
  const numGroups = Math.min(array.length, maxGroups);
  if (numGroups === 0) return [];

  const baseSize = Math.floor(array.length / numGroups);
  const remainder = array.length % numGroups;
  const groups = [];
  let startIndex = 0;

  for (let i = 0; i < numGroups; i++) {
    const size = i < remainder ? baseSize + 1 : baseSize;
    groups.push(array.slice(startIndex, startIndex + size));
    startIndex += size;
  }
  return groups;
}

function normalizeReasoningEffort(effort) {
  if (!effort) return "medium";
  const e = String(effort).toLowerCase().replace(/[\s_-]+/g, "");
  if (e === "max" || e === "extrahigh" || e === "high") return "high";
  if (e === "low" || e === "minimal") return "low";
  return "medium";
}

export async function executeStratifiedRouting(request, rawText, currentUser, cascades, activeKeys, env = null, ctx = null) {
  // Безопасно определяем модель по первым 500 символам
  const headSnippet = rawText.slice(0, 500);
  const isLite = /"model"\s*:\s*"[^"]*lite/i.test(headSnippet);
  const targetCascade = isLite ? cascades.lite : cascades.smart;

  // Безопасно заменяем content: null только для сообщений, не трогая декларации tools
  const preparedPayload = rawText.replaceAll(
    /("role"\s*:\s*"assistant"\s*,\s*"content"\s*:\s*)null/gi,
    '$1""'
  );

  // Построение пар (Модель x Ключ)
  const allPairs = [];
  for (const model of targetCascade) {
    // Случайно перемешиваем ключи для каждой модели, чтобы распределять нагрузку
    const shuffledKeys = [...activeKeys].sort(() => Math.random() - 0.5);
    for (const keyItem of shuffledKeys) {
      allPairs.push({ model, keyItem });
    }
  }

  // Стратификация на 40 групп
  const groups = splitIntoGroups(allPairs, MAX_SUBREQUESTS);

  const now = Date.now();
  let hadTpmError = false;
  let hadRpdError = false;
  let hadRpmError = false;

  // Исполнение цикла
  for (let g = 0; g < groups.length; g++) {
    const currentGroup = groups[g];

    // Отбираем из группы только тех кандидатов, которые НЕ в кулдауне
    const available = currentGroup.filter((c) => {
      const pairKey = `${c.model}:${c.keyItem.id}`;
      if (modelCooldowns[c.model] && modelCooldowns[c.model] > now) return false;
      if (pairCooldowns[pairKey] && pairCooldowns[pairKey] > now) return false;
      return true;
    });

    if (available.length === 0) {
      continue;
    }

    const candidate = available[Math.floor(Math.random() * available.length)];
    const pairKey = `${candidate.model}:${candidate.keyItem.id}`;

    // Якорная замена модели: строго 1 раз в самом начале документа (^)
    const payload = preparedPayload.replace(/^(\s*\{\s*)"model"\s*:\s*"[^"]*"/i, `$1"model":"${candidate.model}"`);
    const startTime = Date.now();

    try {
      const response = await fetch(DEFAULT_GOOGLE_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${candidate.keyItem.key}`,
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
        const statusText = errorObj.status || "";

        if (statusCode === 503 || statusText === "UNAVAILABLE") {
          modelCooldowns[candidate.model] = Date.now() + COOLDOWN_503_MS;
          continue;
        }

        if (statusCode === 429 || statusText === "RESOURCE_EXHAUSTED") {
          const details = errorObj.details || [];
          const quotaFailure = details.find((d) => d["@type"]?.includes("QuotaFailure"));
          const violation = quotaFailure?.violations?.[0] || {};
          const quotaId = violation.quotaId || "";
          const quotaMetric = violation.quotaMetric || "";

          const isDailyLimit = quotaId.includes("PerDay") || quotaMetric.includes("per_day") || errorObj.message?.includes("limit: 20");
          const isTokenLimit = quotaMetric.includes("token_count") || quotaId.includes("TokensPerMinute") || errorObj.message?.includes("tokens per minute");

          if (isTokenLimit) hadTpmError = true;
          if (isDailyLimit) hadRpdError = true;
          if (!isDailyLimit && !isTokenLimit) hadRpmError = true;

          if (isDailyLimit) {
            const nowMs = Date.now();
            const lastUnblock = lastRpdUnblock[pairKey] || 0;
            let unlockTime = getNextMidnightPacificTime();

            if (lastUnblock > 0 && Math.abs(nowMs - lastUnblock) < ONE_HOUR_MS) {
              unlockTime = nowMs + ONE_HOUR_MS;
            }

            pairCooldowns[pairKey] = unlockTime;
            lastRpdUnblock[pairKey] = unlockTime;
          } else {
            const retryInfo = details.find((d) => d["@type"]?.includes("RetryInfo"));
            const delayMs = parseRetryDelayMs(retryInfo?.retryDelay, DEFAULT_RPM_DELAY_MS);
            pairCooldowns[pairKey] = Date.now() + delayMs;
          }
        }
        continue;
      }

      // Успех: фиксируем в аналитике и отдаем поток
      logSuccess(candidate.model, candidate.keyItem.id, durationMs, env, ctx);
      recordSuccess(candidate.model, candidate.keyItem.id, currentUser, env, ctx);

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
        modelCooldowns[candidate.model] = Date.now() + COOLDOWN_503_MS;
      }
      continue;
    }
  }

  // Человекочитаемая подсказка при полном исчерпании попыток
  let advice = "исчерпаны все попытки (${groups.length} групп).";
  if (hadTpmError) {
    advice = "контекст чата слишком велик (превышен минутный лимит токенов TPM). Выполните команду `/compact` в Zed или подождите 1 минуту.";
  } else if (hadRpdError) {
    advice = "исчерпан суточный лимит запросов (RPD) на всех ключах.";
  } else if (hadRpmError) {
    advice = "слишком частые запросы (RPM). Подождите 30-60 секунд перед повтором.";
  }

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
