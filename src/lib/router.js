import { createGeminiStreamPipeline } from "./stream.js";
import { recordSuccess } from "./analytics.js";
import { log } from "./logger.js";

const DEFAULT_GOOGLE_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MAX_SUBREQUESTS = 40;

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

export async function executeStratifiedRouting(request, body, currentUser, cascades, activeKeys) {
  const requestedModel = (body.model || "").toLowerCase();
  const targetCascade = (requestedModel.includes("lite") || requestedModel.includes("fast"))
    ? cascades.lite
    : cascades.smart;

  body.reasoning_effort = normalizeReasoningEffort(body.reasoning_effort);

  // Санитизация сообщений
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((msg) => {
      if (msg.role === "assistant") {
        const patched = { ...msg };
        if (patched.content === null) patched.content = "";
        if (Array.isArray(patched.tool_calls)) {
          patched.tool_calls = patched.tool_calls.map((tc) => ({
            ...tc,
            thought_signature: "skip_thought_signature_validator",
            extra_content: { google: { thought_signature: "skip_thought_signature_validator" } },
          }));
        }
        return patched;
      }
      return msg;
    });
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
  });

  // BASE64: Сериализуем огромный payload ровно один раз
  body.model = "__ROUTER_MODEL_SLOT__";
  const templatePayload = JSON.stringify(body);

  let lastFailedModel = targetCascade[0];
  let lastFailedKeyId = "";
  let lastErrorDetails = null;

  // Исполнение цикла
  for (let g = 0; g < groups.length; g++) {
    const currentGroup = groups[g];
    const candidate = currentGroup[Math.floor(Math.random() * currentGroup.length)];

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
      });

      const durationMs = Date.now() - startTime;

      if (!response.ok) {
        log("warn", "Stratum attempt failed", {
          stratum: `${g + 1}/${groups.length}`,
          model: candidate.model,
          key: candidate.keyItem.id,
          status: response.status,
          durationMs,
        });
        // Если это не последняя попытка — мгновенно сбрасываем стрим без чтения текста
        if (g < groups.length - 1) {
          response.body?.cancel().catch(() => { });
          continue;
        }
        // На последней попытке считываем текст ошибки для логов
        lastErrorDetails = await response.text();
        continue;
      }

      // Успех: фиксируем в аналитике и отдаем поток
      log("success", "Response streaming started", {
        stratum: `${g + 1}/${groups.length}`,
        model: candidate.model,
        key: candidate.keyItem.id,
        durationMs,
      });

      recordSuccess(candidate.model, candidate.keyItem.id, currentUser);

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
      log("warn", "Network or fetch error during attempt", {
        stratum: `${g + 1}/${groups.length}`,
        model: candidate.model,
        key: candidate.keyItem.id,
        error: err.message,
      });

      if (g === groups.length - 1) {
        lastErrorDetails = err.message;
      }
      continue;
    }
  }

  log("error", "All strata exhausted", {
    attemptsMade: groups.length,
    lastFailedModel,
    lastFailedKey: lastFailedKeyId,
  });

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
