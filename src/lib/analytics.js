import { getPersistentLogs } from "./logger.js";

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
  const formattedMatrix = {};
  const allModels = discoveryData ? [...discoveryData.smart, ...discoveryData.lite] : Object.keys(matrix);
  const uniqueModels = [...new Set(allModels)];

  for (const model of uniqueModels) {
    formattedMatrix[model] = {};
    for (const key of allKeys) {
      const hits = (matrix[model] && matrix[model][key.id]) || 0;
      const pct = totalRequests > 0 ? ((hits / totalRequests) * 100).toFixed(1) : "0.0";
      formattedMatrix[model][key.id] = { hits, percentage: Number(pct) };
    }
  }

  return {
    totalRequests,
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
