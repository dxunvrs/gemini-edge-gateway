const MAX_LOGS = 10_000;
const memoryLogs = [];

export function log(level, message, meta = {}) {
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
}

export function getRecentLogs() {
  return memoryLogs;
}
