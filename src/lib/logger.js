const MAX_MEMORY_LOGS = 1000;
const MAX_PERSISTED_LOGS = 100;
let memoryLogs = [];

// Безопасное слияние и сохранение в KV без затирания чужих записей изолятов
async function persistLogEntry(entry, env) {
  if (!env?.GATEWAY_KV) return;
  try {
    const stored = (await env.GATEWAY_KV.get("gateway_logs", "json")) || [];
    const merged = [entry, ...stored];
    // Дедупликация по timestamp + key + message
    const unique = Array.from(
      new Map(merged.map((item) => [item.timestamp + (item.key || "") + (item.message || ""), item])).values()
    );
    await env.GATEWAY_KV.put("gateway_logs", JSON.stringify(unique.slice(0, MAX_PERSISTED_LOGS)));
  } catch (err) {
    console.error("KV persist error:", err);
  }
}

function pushMemoryLog(entry) {
  memoryLogs.unshift(entry);
  if (memoryLogs.length > MAX_MEMORY_LOGS) {
    memoryLogs.pop();
  }
}

// Успешный запрос
export function logSuccess(model, keyId, durationMs, env = null, ctx = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: "success",
    message: "Success",
    model,
    key: keyId,
    status: 200,
    durationMs,
  };


  pushMemoryLog(entry);
  console.log(`[${entry.timestamp}] [SUCCESS] ${model} (${keyId}) in ${durationMs}ms`);

  if (env?.GATEWAY_KV && ctx?.waitUntil) {
    ctx.waitUntil(persistLogEntry(entry, env));
  }
}

// Промежуточная неудачная попытка (429, 503, 401, timeout)
export function logWarn(model, keyId, status, message, rawDetails = null, env = null, ctx = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: "warn",
    message,
    model,
    key: keyId,
    status,
    details: rawDetails,
  };

  pushMemoryLog(entry);
  console.warn(`[${entry.timestamp}] [WARN] ${model} (${keyId}) -> ${status} ${message}`);

  if (env?.GATEWAY_KV && ctx?.waitUntil) {
    ctx.waitUntil(persistLogEntry(entry, env));
  }
}

// Критическая ошибка (когда исчерпаны все попытки роутера)
export function logError(message, status = 429, rawDetails = null, env = null, ctx = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: "error",
    message,
    status,
    details: rawDetails,
  };


  pushMemoryLog(entry);
  console.error(`[${entry.timestamp}] [ERROR] ${message} (${status})`);

  if (env?.GATEWAY_KV && ctx?.waitUntil) {
    ctx.waitUntil(persistLogEntry(entry, env));
  }
}

export async function getPersistentLogs(env) {
  if (env?.GATEWAY_KV) {
    try {
      const stored = await env.GATEWAY_KV.get("gateway_logs", "json");
      if (Array.isArray(stored) && stored.length > 0) {
        const merged = [...memoryLogs, ...stored];
        const unique = Array.from(new Map(merged.map((item) => [item.timestamp + item.key, item])).values());
        memoryLogs = unique.slice(0, MAX_MEMORY_LOGS);
        return memoryLogs;
      }
    } catch { }
  }
  return memoryLogs;
}

export function getRecentLogs() {
  return memoryLogs;
}
