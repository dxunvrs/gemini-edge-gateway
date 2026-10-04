import { createGeminiStreamPipeline } from "./stream.js";
import { recordSuccess } from "./analytics.js";
import { logSuccess, logWarn, logError, getPersistentLogs } from "./logger.js";

const DEFAULT_GOOGLE_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MAX_SUBREQUESTS = 40;

const COOLDOWN_503_MS = 60 * 1000;
const DEFAULT_RPM_DELAY_MS = 60 * 1000;
const ATTEMPT_TIMEOUT_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000; // 1 час для защиты от рассинхрона
const DAY_HOURS_MS = 24 * 60 * 60 * 1000;

const modelCooldowns = {};
const pairCooldowns = {};
const deadKeys = new Set();
const deadModels = new Map();

const lastRpdUnblock = {};
let deadInitialized = false;

async function ensureDeadState(env) {
  if (deadInitialized) return;
  deadInitialized = true;
  try {
    const recentLogs = await getPersistentLogs(env);
    for (const log of recentLogs) {
      const msg = (log.message || "").toUpperCase();
      if (log.model) {
        if (log.status === 404 || msg.includes("404") || msg.includes("NOT_FOUND")) {
          deadModels.set(log.model, "404");
        } else if (msg.includes("LIMIT: 0") || msg.includes("ZERO")) {
          deadModels.set(log.model, "limit: 0");
        }
      }
      if (log.key && (log.status === 401 || log.status === 403 || msg.includes("AUTH") || msg.includes("INVALID"))) {
        deadKeys.add(log.key);
      }
    }
  } catch (err) {
    console.error("ensureDeadState error:", err);
  }
}

function getNextMidnightUtc() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

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

function classifyGoogleError(statusCode, errorObj) {
  if (statusCode === 404 || errorObj?.status === "NOT_FOUND") {
    return { type: "NOT_FOUND" };
  }
  const message = (errorObj?.message || "").toLowerCase();

  if (message.includes("valid API key")) {
    return { type: "AUTH" };
  }

  if (message.includes("limit: 0")) {
    return { type: "ZERO_QUOTA" };
  }

  if (statusCode === 503 || statusCode === 500 || errorObj?.status === "UNAVAILABLE") {
    return { type: "UNAVAILABLE" };
  }

  const details = errorObj?.details || [];
  const quotaFailures = details.filter((d) => d["@type"]?.includes("QuotaFailure"));
  const violations = quotaFailures.flatMap((q) => q.violations || []);

  const quotaIds = violations.map((v) => (v.quotaId || "").toLowerCase()).join(" ");
  const quotaMetrics = violations.map((v) => (v.quotaMetric || "").toLowerCase()).join(" ");

  if (statusCode === 429 || errorObj?.status === "RESOURCE_EXHAUSTED") {
    // TPM (tokens per minute)
    const isTpm = quotaIds.includes("tokenspermodelperminute") || quotaMetrics.includes("input_token_count");
    if (isTpm) { return { type: "TPM" }; }

    // RPD (requests per day)
    const isDaily = quotaIds.includes("requestsperday");
    if (isDaily) { return { type: "RPD" }; }

    // RPM (requests per minute)
    const isRpm = quotaIds.includes("requestsperminute");
    if (isRpm) { return { type: "RPM" }; }
  }

  return { type: "OTHER" };
}

// Two-Zone Split
function prepareSanitizedTemplate(rawText) {
  const firstImageIndex = rawText.indexOf('"image_url"');
  let cutoff = rawText.length;

  if (firstImageIndex !== -1) {
    const msgStart = rawText.lastIndexOf('{"role"', firstImageIndex);
    cutoff = msgStart !== -1 ? msgStart : firstImageIndex;
  }

  let metaZone = rawText.slice(0, cutoff);
  let dataZone = rawText.slice(cutoff);

  metaZone = metaZone
    .replaceAll('"content":null', '"content":""')
    .replaceAll('"content": null', '"content":""');

  const effortRegexMax = /(?<!\\)"reasoning_effort"\s*:\s*"(max|maximum|extrahigh)"/gi;
  const effortRegexMin = /(?<!\\)"reasoning_effort"\s*:\s*"(min|minimum|none)"/gi;
  metaZone = metaZone.replace(effortRegexMax, '"reasoning_effort":"high"').replace(effortRegexMin, '"reasoning_effort":"low"');

  if (dataZone.length > 0) {
    dataZone = dataZone.replace(/(?<!\\)"role"\s*:\s*"tool"/g, '"role":"user"');

    const tailLimit = Math.max(0, dataZone.length - 1000);
    const tail = dataZone.slice(tailLimit)
      .replace(effortRegexMax, '"reasoning_effort":"high"')
      .replace(effortRegexMin, '"reasoning_effort":"low"');
    dataZone = dataZone.slice(0, tailLimit) + tail;
  }

  let fullText = metaZone + dataZone;

  fullText = fullText.replace(
    /"tool_calls"\s*:\s*(\[\s*\{[\s\S]*?\}\s*\])(?=\s*[,}])/g,
    (match, arrayStr) => {
      try {
        const calls = JSON.parse(arrayStr);
        if (Array.isArray(calls)) {
          let modified = false;
          for (const call of calls) {
            if (call.type === "function") {
              const hasSig = call.extra_content?.google?.thought_signature;
              if (!hasSig) {
                if (!call.extra_content) call.extra_content = {};
                if (!call.extra_content.google) call.extra_content.google = {};
                call.extra_content.google.thought_signature = "skip_thought_signature_validator";
                modified = true;
              }
            }
          }
          if (modified) {
            return `"tool_calls":${JSON.stringify(calls)}`;
          }
        }
      } catch { }
      return match;
    }
  );

  return fullText;
}

export function getRouterLiveState() {
  return {
    modelCooldowns,
    pairCooldowns,
    deadKeys: Array.from(deadKeys),
    deadModels: Array.from(deadModels.keys()),
    deadModelsMap: Object.fromEntries(deadModels)
  };
}

export async function executeStratifiedRouting(request, rawText, currentUser, cascades, activeKeys, env = null, ctx = null) {
  await ensureDeadState(env);

  // Очистка устаревших блокировок в памяти
  const nowMs = Date.now();
  for (const k of Object.keys(pairCooldowns)) {
    if (pairCooldowns[k] <= nowMs) {
      delete pairCooldowns[k];
    }
  }

  const headSnippet = rawText.slice(0, 500);
  const isLite = /"model"\s*:\s*"[^"]*lite/i.test(headSnippet);
  const targetCascade = isLite ? cascades.lite : cascades.smart;

  let hadTpmError = false;
  let hadRpdError = false;
  let hadRpmError = false;
  let hadAuthError = false;
  let attemptsCount = 0;

  const basePayload = prepareSanitizedTemplate(rawText);

  // Каскадный перебор: от лучших моделей к базовым
  for (const model of targetCascade) {
    if (attemptsCount >= MAX_SUBREQUESTS) break;
    if (deadModels.has(model)) continue;

    if (modelCooldowns[model] && modelCooldowns[model] > Date.now()) {
      continue;
    }
    const payload = basePayload.replace(/(?<!\\)"model"\s*:\s*"[^"]*"/, `"model":"${model}"`);
    for (const keyItem of activeKeys) {
      if (attemptsCount >= MAX_SUBREQUESTS) break;
      if (deadKeys.has(keyItem.id)) continue;

      const pairKey = `${model}:${keyItem.id}`;
      if (pairCooldowns[pairKey] && pairCooldowns[pairKey] > Date.now()) continue;

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

          const rawError = Array.isArray(errorData) ? errorData[0] : errorData;
          const errorObj = rawError?.error || rawError || {};
          const statusCode = response.status;

          const errInfo = classifyGoogleError(statusCode, errorObj);
          if (errInfo.type === "NOT_FOUND") {
            deadModels.set(model, "404");
            logWarn(model, keyItem.id, statusCode, `Model Deprecated/Not Found (404)`, errorData, durationMs, env, ctx);
            break;
          }

          if (errInfo.type === "ZERO_QUOTA") {
            deadModels.set(model, "limit: 0");
            logWarn(model, keyItem.id, statusCode, `Zero Free Quota (limit: 0)`, errorData, durationMs, env, ctx);
            break;
          }

          if (errInfo.type === "AUTH") {
            hadAuthError = true;
            deadKeys.add(keyItem.id);
            logWarn(model, keyItem.id, statusCode, `Auth Error (Invalid Key)`, errorData, durationMs, env, ctx);
            continue;
          }

          if (errInfo.type === "UNAVAILABLE") {
            modelCooldowns[model] = Date.now() + COOLDOWN_503_MS;
            logWarn(model, keyItem.id, statusCode, `Model Overloaded (503)`, errorData, durationMs, env, ctx);
            break;
          }

          if (errInfo.type === "RPD") {
            hadRpdError = true;
            const nowMs = Date.now();
            const lastUnblock = lastRpdUnblock[pairKey] || 0;
            let unlockTime = getNextMidnightUtc();

            if (lastUnblock > 0 && Math.abs(nowMs - lastUnblock) < ONE_HOUR_MS) {
              unlockTime = nowMs + ONE_HOUR_MS;
            }

            pairCooldowns[pairKey] = unlockTime;
            lastRpdUnblock[pairKey] = unlockTime;
            logWarn(model, keyItem.id, statusCode, `RPD Daily Limit`, errorData, durationMs, env, ctx);
            continue;
          }

          if (errInfo.type === "TPM") {
            hadTpmError = true;
            logWarn(model, keyItem.id, statusCode, `TPM Token Limit`, errorData, durationMs, env, ctx);
            continue;
          }

          if (errInfo.type === "RPM") {
            hadRpmError = true;
            const retryInfo = (errorObj?.details || []).find((d) => d["@type"]?.includes("RetryInfo"));
            const delayMs = parseRetryDelayMs(retryInfo?.retryDelay, DEFAULT_RPM_DELAY_MS);
            pairCooldowns[pairKey] = Date.now() + delayMs;
            logWarn(model, keyItem.id, statusCode, `RPM Minute Limit (${Math.round(delayMs / 1000)}s)`, errorData, durationMs, env, ctx);
            continue;
          }

          logWarn(model, keyItem.id, statusCode, `API Error`, errorData, durationMs, env, ctx);
          continue;
        }

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
        const durationMs = Date.now() - startTime;
        logWarn(model, keyItem.id, 0, isTimeout ? `Timeout (${ATTEMPT_TIMEOUT_MS / 1000}s)` : err.message, null, durationMs, env, ctx);
        break;
      }
    }
  }

  let advice = `исчерпаны все попытки (${attemptsCount} запросов).`;
  let errorReason = "Exhausted all attempts";

  if (hadTpmError) {
    advice = "контекст чата слишком велик (превышен минутный лимит токенов TPM). Выполните команду `/compact` в Zed или подождите 1 минуту.";
    errorReason = "TPM Limit (Tokens/Minute)";
  } else if (hadRpdError) {
    advice = "исчерпан суточный лимит запросов (RPD) на всех ключах для доступных моделей.";
    errorReason = "RPD Limit (Requests/Day)";
  } else if (hadRpmError) {
    advice = "слишком частые запросы (RPM). Подождите 30-60 секунд перед повтором.";
    errorReason = "RPM Limit (Requests/Minute)";
  } else if (hadAuthError) {
    advice = "все предоставленные ключи GEMINI_KEY отклонены Google API (ошибка 401/403). Проверьте актуальность ключей в переменных Cloudflare.";
    errorReason = "Auth Error (401/403 Invalid Key)";
  } else {
    advice = `Неизвестная ошибка`;
    errorReason = `UNDEFINED`;
  }

  logError(errorReason, 429, attemptsCount, env, ctx);

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
