import { getRecentLogs } from "./logger.js";

const matrix = {};
let lastResponse = null;
let totalRequests = 0;

export function recordSuccess(model, keyId, user) {
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
}

export function getAnalyticsSnapshot(discoveryData, allKeys) {
  // Строим сводную матрицу с процентами
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
    logs: getRecentLogs(), // Логи готовы для отображения в дашборде
    discovery: discoveryData ? {
      lastUpdated: new Date(discoveryData.lastUpdated).toISOString(),
      rawCount: discoveryData.rawModels.length,
      rawModels: discoveryData.rawModels,
      smart: discoveryData.smart,
      lite: discoveryData.lite,
      keysStatus: discoveryData.validatedKeys.map((k) => ({ id: k.id, isValid: k.isValid, status: k.status })),
    } : null,
  };
}
