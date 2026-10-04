export function parseConfig(env) {
  // Сбор и нормализация ключей Gemini
  const keys = [];
  for (const [name, val] of Object.entries(env)) {
    if (/^gemini[-_]key/i.test(name) && typeof val === "string") {
      const parts = val.split(",").map((k) => k.trim()).filter(Boolean);
      parts.forEach((k, idx) => {
        // Проверяем только отсутствие внутренних пробелов
        if (!/\s/.test(k)) {
          keys.push({
            id: parts.length > 1 ? `${name.toUpperCase()} #${idx + 1}` : name.toUpperCase(),
            key: k,
            envVar: name,
          });
        }
      });
    }
  }

  // Сбор пользователей (auth_secret*)
  const authorizedUsers = [];
  for (const [name, val] of Object.entries(env)) {
    if (/^auth[-_]secret/i.test(name) && typeof val === "string") {
      const userTag = name.replace(/^auth[-_]secrets?[-_]?/i, "") || "OWNER";
      const secrets = val.split(",").map((s) => s.trim()).filter(Boolean);
      secrets.forEach((secret) => {
        authorizedUsers.push({
          user: userTag,
          secret: secret,
        });
      });
    }
  }

  // Сбор паролей дашборда (dashboard_password*)
  const dashboardPasswords = [];
  for (const [name, val] of Object.entries(env)) {
    if (/^dashboard[-_]password/i.test(name) && typeof val === "string") {
      const passes = val.split(",").map((p) => p.trim()).filter(Boolean);
      dashboardPasswords.push(...passes);
    }
  }

  return { keys, authorizedUsers, dashboardPasswords };
}
