const MAX_LOGS = 10_000;
const memoryLogs = [];

export function log(level, message, meta = {}, env = null, ctx = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    level, // "info" | "warn" | "error" | "success"
    message,
    ...meta,
  };

  memoryLogs.unshift(entry);
  if (memoryLogs.length > MAX_LOGS) {
    memoryLogs.pop();
  }

  const metaStr = Object.keys(meta).length > 0 ? ` | ${JSON.stringify(meta)}` : "";
  const consoleLine = `[${entry.timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;

  if (level === "error") {
    console.error(consoleLine);
  } else if (level === "warn") {
    console.warn(consoleLine);
  } else {
    console.log(consoleLine);
  }

  if (env?.GATEWAY_KV && ctx?.waitUntil) {
    ctx.waitUntil(
      env.GATEWAY_KV.put("gateway_logs", JSON.stringify(memoryLogs.slice(0, 200))).catch(() => { })
    );
  }
}

export async function getPersistentLogs(env) {
  if (env?.GATEWAY_KV) {
    try {
      const stored = await env.GATEWAY_KV.get("gateway_logs", "json");
      if (Array.isArray(stored) && stored.length > 0) {
        const merged = [...memoryLogs, ...stored];
        const unique = Array.from(new Map(merged.map(item => [item.timestamp + item.message, item])).values());
        memoryLogs = unique.slice(0, MAX_LOGS);
        return memoryLogs;
      }
    } catch { }
  }
  return memoryLogs;
}

export function getRecentLogs() {
  return memoryLogs;
}
