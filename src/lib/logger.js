const MAX_MEMORY_LOGS = 1000;
const MAX_PERSISTED_LOGS = 200;
let memoryLogs = [];

// Сохранение лога в SQLite базу D1
async function persistLogEntry(entry, env) {
  if (!env?.DB) return;
  try {
    await env.DB.prepare(`
      INSERT INTO logs (timestamp, level, message, model, key_id, status, duration_ms, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      entry.timestamp,
      entry.level,
      entry.message,
      entry.model || null,
      entry.key || null,
      entry.status ?? null,
      entry.durationMs ?? null,
      entry.details ? JSON.stringify(entry.details) : null
    ).run();
  } catch (err) {
    console.error("D1 persistLogEntry error:", err);
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

  if (env?.DB && ctx?.waitUntil) {
    ctx.waitUntil(persistLogEntry(entry, env));
  }
}

export function logWarn(model, keyId, status, message, rawDetails = null, durationMs = null, env = null, ctx = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: "warn",
    message,
    model,
    key: keyId,
    status,
    details: rawDetails,
    durationMs,
  };

  pushMemoryLog(entry);
  console.warn(`[${entry.timestamp}] [WARN] ${model} (${keyId}) -> ${status} ${message} in ${durationMs != null ? durationMs + 'ms' : 'N/A'}`);

  if (env?.DB && ctx?.waitUntil) {
    ctx.waitUntil(persistLogEntry(entry, env));
  }
}

// Критический отказ шлюза
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

  if (env?.DB && ctx?.waitUntil) {
    ctx.waitUntil(persistLogEntry(entry, env));
  }
}

export async function getPersistentLogs(env) {
  if (env?.DB) {
    try {
      const { results } = await env.DB.prepare(`
        SELECT timestamp, level, message, model, key_id AS key, status, duration_ms AS durationMs, details
        FROM logs
        ORDER BY timestamp DESC
        LIMIT ?
      `).bind(MAX_PERSISTED_LOGS).all();

      if (Array.isArray(results) && results.length > 0) {
        return results.map((r) => ({
          ...r,
          details: r.details ? JSON.parse(r.details) : null,
        }));
      }
    } catch (err) {
      console.error("D1 getPersistentLogs error:", err);
    }
  }
  return memoryLogs;
}

export function getRecentLogs() {
  return memoryLogs;
}
