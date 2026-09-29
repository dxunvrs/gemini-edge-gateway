let CACHED_DATA = null;
let LAST_DISCOVERY_TIME = 0;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function getDiscoveryData(keys) {
  const now = Date.now();
  if (CACHED_DATA && (now - LAST_DISCOVERY_TIME < CACHE_TTL_MS)) {
    return CACHED_DATA;
  }

  if (!keys || keys.length === 0) {
    throw new Error("No Gemini keys provided");
  }

  const parseVer = (str) => {
    const match = str.match(/gemini[-_]?(\d+(?:\.\d+)?)/i);
    return match ? parseFloat(match[1]) : 0;
  };

  // Валидация ключей параллельным запросом с таймаутом 5 сек
  const keyValidationPromises = keys.map(async (k) => {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${k.key}`, {
        signal: AbortSignal.timeout(5000),
      });
      return { id: k.id, key: k.key, isValid: res.ok, status: res.status };
    } catch {
      return { id: k.id, key: k.key, isValid: false, status: 0 };
    }
  });

  const validatedKeysResults = await Promise.all(keyValidationPromises);
  const activeKeys = validatedKeysResults.filter((k) => k.isValid);

  if (activeKeys.length === 0) {
    if (CACHED_DATA) return CACHED_DATA;
    throw new Error("All provided GEMINI_KEY entries failed validation via Google API");
  }

  // Получаем список моделей через первый активный ключ
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${activeKeys[0].key}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    if (CACHED_DATA) return CACHED_DATA;
    throw new Error(`Failed to fetch models list: HTTP ${res.status}`);
  }

  const data = await res.json();
  const rawModels = (data.models || []).map((m) => m.name.replace(/^models\//, ""));

  // Строгий фильтр чат-моделей: исключаем tts, transcribe, customtools, embedding, image
  const isChatModel = (name) => {
    return /^gemini-\d+(\.\d+)?-(flash|flash-lite|pro)$/i.test(name.toLowerCase());
  };

  const chatModels = rawModels.filter(isChatModel);
  const sorted = chatModels.sort((a, b) => parseVer(b) - parseVer(a));

  const smart = sorted.filter((m) => !m.toLowerCase().includes("lite"));
  const lite = sorted.filter((m) => m.toLowerCase().includes("lite"));

  CACHED_DATA = {
    rawModels,
    chatModels,
    smart,
    lite,
    validatedKeys: validatedKeysResults,
    activeKeys,
    lastUpdated: now,
  };
  LAST_DISCOVERY_TIME = now;

  return CACHED_DATA;
}
