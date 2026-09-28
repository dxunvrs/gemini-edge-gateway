import { parseConfig } from "./lib/config.js";
import { authenticate } from "./lib/auth.js";
import { getDiscoveryData } from "./lib/discovery.js";
import { executeStratifiedRouting } from "./lib/router.js";
import { getAnalyticsSnapshot } from "./lib/analytics.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { keys, authorizedUsers } = parseConfig(env);

    // Авторизация
    const authResult = authenticate(request, authorizedUsers);

    // Эндпоинт статистики для дашборда
    if (url.pathname === "/api/stats") {
      if (!authResult.ok) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      try {
        const discovery = await getDiscoveryData(keys);
        const stats = getAnalyticsSnapshot(discovery, keys);
        return new Response(JSON.stringify(stats), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Список моделей для Zed (/v1/models)
    if (url.pathname.endsWith("/models")) {
      return new Response(
        JSON.stringify({
          object: "list",
          data: [
            { id: "Gemini Smart", object: "model" },
            { id: "Gemini Lite", object: "model" },
          ],
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Обработка промптов (/v1/chat/completions)
    if (url.pathname.endsWith("/chat/completions")) {
      if (!authResult.ok) {
        return new Response(JSON.stringify({ error: "Unauthorized: Invalid Access Token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (keys.length === 0) {
        return new Response(JSON.stringify({ error: "No GEMINI_KEY variables configured in Cloudflare" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
      }

      try {
        const discovery = await getDiscoveryData(keys);
        return await executeStratifiedRouting(request, body, authResult.user, discovery, discovery.activeKeys);
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Главная страница (пока заглушка)
    if (url.pathname === "/") {
      return new Response("Gemini Edge Gateway is active. Use /api/stats or /v1/chat/completions.", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
