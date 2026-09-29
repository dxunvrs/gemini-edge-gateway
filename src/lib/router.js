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

export async function executeStratifiedRouting(request, body, currentUser, cascades, activeKeys, env = null, ctx = null) {
  const requestedModel = (body.model || "").toLowerCase();
  const targetCascade = (requestedModel.includes("lite") || requestedModel.includes("fast"))
    ? cascades.lite
    : cascades.smart;

  body.reasoning_effort = normalizeReasoningEffort(body.reasoning_effort);

  // In-place санитизация сообщений (экономим CPU)
  if (Array.isArray(body.messages)) {
    for (let i = 0; i < body.messages.length; i++) {
      const msg = body.messages[i];
      if (msg.role === "assistant") {
        if (msg.content === null) msg.content = "";
        if (Array.isArray(msg.tool_calls)) {
          for (let j = 0; j < msg.tool_calls.length; j++) {
            const tc = msg.tool_calls[j];
            tc.thought_signature = "skip_thought_signature_validator";
            tc.extra_content = { google: { thought_signature: "skip_thought_signature_validator" } };
          }
        }
      }
    }
  }

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

  log("info", "New chat completion request", {
    user: currentUser,
    targetCascade: requestedModel.includes("lite") ? "lite" : "smart",
    totalStrata: groups.length,
    activeKeysCount: activeKeys.length,
  }, env, ctx);

  // BASE64: Сериализуем огромный payload ровно один раз
  body.model = "__ROUTER_MODEL_SLOT__";
  const templatePayload = JSON.stringify(body);

  let lastFailedModel = targetCascade[0];
  let lastFailedKeyId = "";
  let lastErrorDetails = null;
  const now = Date.now();

  // Исполнение цикла
  for (let g = 0; g < groups.length; g++) {
    const currentGroup = groups[g];
    const candidate = currentGroup[Math.floor(Math.random() * currentGroup.length)];
    const pairKey = `${candidate.model}:${candidate.keyItem.id}`;

    // Проверка Circuit Breaker для модели (503 кулдаун)
    if (modelCooldowns[candidate.model] && modelCooldowns[candidate.model] > now) {
      continue;
    }

    // Проверка штрафного бокса для пары [модель + ключ] (429 кулдаун)
    if (pairCooldowns[pairKey] && pairCooldowns[pairKey] > now) {
      continue;
    }

    lastFailedModel = candidate.model;
    lastFailedKeyId = candidate.keyItem.id;

    // Быстрая строковая подстановка модели без повторного парсинга base64 картинок
    const payload = templatePayload.replace('"__ROUTER_MODEL_SLOT__"', JSON.stringify(candidate.model));
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
          log("warn", "Model 503 High Demand: entering 5m cooldown and skipping model", {
            model: candidate.model,
            cooldownMinutes: 5,
            durationMs,
          }, env, ctx);
          continue;
        }

        if (statusCode === 429 || statusText === "RESOURCE_EXHAUSTED") {
          const details = errorObj.details || [];
          const quotaFailure = details.find((d) => d["@type"]?.includes("QuotaFailure"));
          const violation = quotaFailure?.violations?.[0] || {};
          const quotaId = violation.quotaId || "";
          const quotaMetric = violation.quotaMetric || "";

          const isDailyLimit = quotaId.includes("PerDay") || quotaMetric.includes("per_day") || errorObj.message?.includes("limit: 20");

          if (isDailyLimit) {
            const nowMs = Date.now();
            const lastUnblock = lastRpdUnblock[pairKey] || 0;
            let unlockTime = getNextMidnightPacificTime();

            // Если прошло менее часа с момента выхода из предыдущего RPD (защита от рассинхрона серверов Google)
            if (lastUnblock > 0 && Math.abs(nowMs - lastUnblock) < ONE_HOUR_MS) {
              unlockTime = nowMs + ONE_HOUR_MS;
            }

            pairCooldowns[pairKey] = unlockTime;
            lastRpdUnblock[pairKey] = unlockTime;

            log("warn", "Daily quota exhausted (RPD): blocked until reset", {
              model: candidate.model,
              key: candidate.keyItem.id,
              unlocksAtLocal: new Date(unlockTime).toLocaleString(),
              durationMs,
            }, env, ctx);
          } else {
            const retryInfo = details.find((d) => d["@type"]?.includes("RetryInfo"));
            const delayMs = parseRetryDelayMs(retryInfo?.retryDelay, DEFAULT_RPM_DELAY_MS);
            pairCooldowns[pairKey] = Date.now() + delayMs;
            log("warn", "Minute quota exceeded (RPM/TPM): temporary cooldown", {
              model: candidate.model,
              key: candidate.keyItem.id,
              cooldownSeconds: Math.ceil(delayMs / 1000),
              durationMs,
            }, env, ctx);
          }
          continue;
        }

        log("warn", "Stratum attempt failed", {
          stratum: `${g + 1}/${groups.length}`,
          model: candidate.model,
          key: candidate.keyItem.id,
          status: response.status,
          durationMs,
        }, env, ctx);
        continue;
      }

      // Успех: фиксируем в аналитике и отдаем поток
      log("success", "Response streaming started", {
        stratum: `${g + 1}/${groups.length}`,
        model: candidate.model,
        key: candidate.keyItem.id,
        status: 200,
        durationMs,
      }, env, ctx);

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
      const durationMs = Date.now() - startTime;
      const isTimeout = err.name === "TimeoutError" || err.name === "AbortError";

      if (isTimeout) {
        modelCooldowns[candidate.model] = Date.now() + COOLDOWN_503_MS;
      }

      log("warn", "Network or fetch error during attempt", {
        stratum: `${g + 1}/${groups.length}`,
        model: candidate.model,
        key: candidate.keyItem.id,
        status: isTimeout ? "TIMEOUT" : "ERR",
        durationMs,
        error: err.message,
      }, env, ctx);

      if (g === groups.length - 1) {
        lastErrorDetails = isTimeout ? "Google API timed out after 30s" : err.message;
      }
      continue;
    }
  }

  log("error", "All strata exhausted", {
    attemptsMade: groups.length,
    lastFailedModel,
    lastFailedKey: lastFailedKeyId,
  }, env, ctx);

  return new Response(
    JSON.stringify({
      error: "Gemini Edge Gateway exhausted across all strata and keys",
      last_failed_model: lastFailedModel,
      last_failed_key: lastFailedKeyId,
      attempts_made: groups.length,
      details: lastErrorDetails,
    }),
    { status: 429, headers: { "Content-Type": "application/json" } }
  );
}
