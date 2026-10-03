import { getPersistentLogs } from "./logger.js";
import { getRouterLiveState } from "./router.js";

let matrix = {};
let lastResponse = null;
let totalRequests = 0;

export function recordSuccess(model, keyId, user, env = null, ctx = null) {
  totalRequests += 1;
  lastResponse = {
    model,
    keyId,
    user,
    timestamp: new Date().toISOString(),
  };

  if (!matrix[model]) {
    matrix[model] = {};
  }
  matrix[model][keyId] = (matrix[model][keyId] || 0) + 1;

  if (env?.DB && ctx?.waitUntil) {
    const payload = JSON.stringify({ matrix, lastResponse, totalRequests });
    ctx.waitUntil(
      env.DB.prepare(`
        INSERT INTO stats_kv (key, value, updated_at)
        VALUES ('gateway_stats', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).bind(payload, Date.now()).run().catch((err) => {
        console.error("D1 stats persist error:", err);
      })
    );
  }
}

export async function getAnalyticsSnapshot(discoveryData, allKeys, env) {
  if (totalRequests === 0 && env?.DB) {
    try {
      const row = await env.DB.prepare(
        "SELECT value FROM stats_kv WHERE key = 'gateway_stats'"
      ).first();

      if (row?.value) {
        const saved = JSON.parse(row.value);
        matrix = saved.matrix || {};
        lastResponse = saved.lastResponse || null;
        totalRequests = saved.totalRequests || 0;
      }
    } catch (err) {
      console.error("D1 stats read error:", err);
    }
  }

  const logs = await getPersistentLogs(env);
  const liveState = getRouterLiveState();
  const now = Date.now();

  const formattedMatrix = {};
  const allModels = discoveryData ? [...discoveryData.smart, ...discoveryData.lite] : Object.keys(matrix);
  const uniqueModels = [...new Set(allModels)];

  // Определение последнего статуса ответа для каждой пары (модель, ключ) по логам (от свежих к старым)
  const lastStatusMap = {};
  for (const log of logs) {
    if (log.model && log.key) {
      const pairKey = `${log.model}:${log.key}`;
      if (!lastStatusMap[pairKey]) {
        let code = "-";
        const logTime = new Date(log.timestamp).getTime();

        if (log.status === 200) {
          code = "200";
        } else {
          const msg = (log.message || "").toUpperCase();
          let type = "UNDEFINED";
          if (msg.includes("RPD")) type = "RPD";
          else if (msg.includes("TPM")) type = "TPM";
          else if (msg.includes("RPM")) type = "RPM";
          else if (msg.includes("503") || log.status === 503) type = "503";
          else if (msg.includes("LIMIT: 0") || msg.includes("ZERO")) type = "limit: 0";
          else if (msg.includes("AUTH") || msg.includes("INVALID") || log.status === 401 || log.status === 403) type = "KEY_ERR";
          else if (msg.includes("404") || log.status === 404) type = "404";
          else if (log.status) type = String(log.status);

          if (type === "RPD") {
            const logDate = new Date(log.timestamp);
            const todayUtc = new Date();
            if (logDate.getUTCDate() !== todayUtc.getUTCDate()) {
              type = "-";
            }
          }

          if (["503", "RPM", "TPM"].includes(type) && (now - logTime > 60000)) {
            type = "-";
          }

          code = type;
        }
        lastStatusMap[pairKey] = code;
      }
    }
  }

  for (const model of uniqueModels) {
    formattedMatrix[model] = {};
    for (const key of allKeys) {
      const pairKey = `${model}:${key.id}`;
      const hits = (matrix[model] && matrix[model][key.id]) || 0;

      let status = "-";
      const unlockTime = liveState.pairCooldowns[pairKey];
      const isDeadKey = liveState.deadKeys.includes(key.id);
      const isDeadModel = liveState.deadModels.includes(model);

      if (isDeadKey) {
        status = "KEY_ERR";
      } else if (unlockTime && unlockTime > now) {
        const historyStatus = lastStatusMap[pairKey];
        status = (historyStatus && historyStatus !== "200") ? historyStatus : "RPD";
      } else if (liveState.modelCooldowns[model] && liveState.modelCooldowns[model] > now) {
        status = "503";
      } else if (isDeadModel) {
        const historyStatus = lastStatusMap[pairKey];
        status = (historyStatus === "limit: 0" || historyStatus === "404") ? historyStatus : "404";
      } else {
        status = lastStatusMap[pairKey] || "-";
      }

      formattedMatrix[model][key.id] = { hits, status };
    }
  }

  let successCount = 0;
  let errorCount = 0;

  if (env?.DB) {
    try {
      const statsRow = await env.DB.prepare(`
        SELECT
          COUNT(CASE WHEN level = 'success' THEN 1 END) as success_count,
          COUNT(CASE WHEN level = 'error' THEN 1 END) as error_count
        FROM logs
      `).first();

      if (statsRow) {
        successCount = statsRow.success_count || 0;
        errorCount = statsRow.error_count || 0;
      }
    } catch (e) {
      console.error("D1 stats counts error:", e);
    }
  }

  // Если в D1 записей нет, считаем по memoryLogs
  if (successCount === 0 && errorCount === 0 && logs.length > 0) {
    successCount = logs.filter(l => l.level === "success").length;
    errorCount = logs.filter(l => l.level === "error").length;
  }

  const totalEvaluated = successCount + errorCount;
  const successRate = totalEvaluated > 0
    ? `${((successCount / totalEvaluated) * 100).toFixed(1)}% (${successCount}/${totalEvaluated})`
    : "100% (0/0)";

  return {
    totalRequests,
    successRate,
    successCount,
    errorCount,
    lastResponse,
    matrix: formattedMatrix,
    logs,
    discovery: discoveryData ? {
      lastUpdated: new Date(discoveryData.lastUpdated).toISOString(),
      rawCount: discoveryData.rawModels.length,
      rawModels: discoveryData.rawModels,
      smart: discoveryData.smart,
      lite: discoveryData.lite,
      keysStatus: discoveryData.validatedKeys.map((k) => ({
        id: k.id,
        isValid: k.isValid,
        status: k.status,
        unchecked: k.unchecked || false,
      })),
    } : null,
  };
}
