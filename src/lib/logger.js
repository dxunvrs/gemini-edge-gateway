const MAX_MEMORY_LOGS = 1000;
const MAX_PERSISTED_LOGS = 100;
let memoryLogs = [];

// Функция фиксации успешного запроса (пишет в KV ровно 1 раз при успехе)
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

  memoryLogs.unshift(entry);
  if (memoryLogs.length > MAX_MEMORY_LOGS) {
    memoryLogs.pop();
  }

  console.log(`[${entry.timestamp}] [SUCCESS] ${model} (${keyId}) in ${durationMs}ms`);

  if (env?.GATEWAY_KV && ctx?.waitUntil) {
    const compactLogs = memoryLogs.slice(0, MAX_PERSISTED_LOGS);
    ctx.waitUntil(
      env.GATEWAY_KV.put("gateway_logs", JSON.stringify(compactLogs)).catch(() => { })
    );
  }
}

export function logError(message, status = 429, env = null, ctx = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: "error",
    message,
    status,
  };

  memoryLogs.unshift(entry);
  if (memoryLogs.length > MAX_MEMORY_LOGS) {
    memoryLogs.pop();
  }

  console.error(`[${entry.timestamp}] [ERROR] ${message} (${status})`);

  if (env?.GATEWAY_KV && ctx?.waitUntil) {
    const compactLogs = memoryLogs.slice(0, MAX_PERSISTED_LOGS);
    ctx.waitUntil(
      env.GATEWAY_KV.put("gateway_logs", JSON.stringify(compactLogs)).catch(() => { })
    );
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
