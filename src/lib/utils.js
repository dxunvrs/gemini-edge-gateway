export const ONE_HOUR_MS = 60 * 60 * 1000;
export const DAY_HOURS_MS = 24 * 60 * 60 * 1000;
export const COOLDOWN_503_MS = 10 * 1000;
export const DEFAULT_RPM_DELAY_MS = 60 * 1000;
export const DEFAULT_TIMEOUT_DELAY_MS = 3 * 60 * 1000;

export function getTodayMidnightUtc() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

export function getNextMidnightUtc() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

export function parseRetryDelayMs(retryDelayStr, defaultMs = DEFAULT_RPM_DELAY_MS) {
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

export function classifyGoogleError(statusCode, errorObj) {
  const status = errorObj?.status || "";
  const message = errorObj?.message || "";
  const lowerMessage = message.toLowerCase();

  if (statusCode === 404 || status === "NOT_FOUND") {
    return { type: "NOT_FOUND" };
  }

  if (lowerMessage.includes("valid API key") || statusCode === 401 || statusCode === 403 || status === "PERMISSION_DENIED" || status === "UNAUTHENTICATED") {
    return { type: "AUTH" };
  }

  if (lowerMessage.includes("limit: 0")) {
    return { type: "ZERO_QUOTA" };
  }

  if (statusCode === 503 || statusCode === 500 || status === "UNAVAILABLE" || status === "INTERNAL") {
    return { type: "UNAVAILABLE" };
  }

  const details = errorObj?.details || [];
  const quotaFailures = details.filter((d) => d["@type"]?.includes("QuotaFailure"));
  const violations = quotaFailures.flatMap((q) => q.violations || []);

  const quotaIds = violations.map((v) => (v.quotaId || "").toLowerCase()).join(" ");
  const quotaMetrics = violations.map((v) => (v.quotaMetric || "").toLowerCase()).join(" ");

  if (statusCode === 429 || status === "RESOURCE_EXHAUSTED") {
    const isTpm = quotaIds.includes("tokenspermodelperminute") || quotaMetrics.includes("input_token_count");
    if (isTpm) { return { type: "TPM" }; }

    const isDaily = quotaIds.includes("requestsperday");
    if (isDaily) { return { type: "RPD" }; }

    return { type: "RPM" };
  }

  if (statusCode === 400 || status === "INVALID_ARGUMENT") {
    return { type: "INVALID_ARGUMENT", status, message };
  }

  return { type: "OTHER", status, message };
}
