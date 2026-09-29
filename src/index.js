import { parseConfig } from "./lib/config.js";
import { authenticate } from "./lib/auth.js";
import { getDiscoveryData } from "./lib/discovery.js";
import { executeStratifiedRouting } from "./lib/router.js";
import { getAnalyticsSnapshot } from "./lib/analytics.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { keys, authorizedUsers } = parseConfig(env);

    // Публичный эндпоинт аналитики с поддержкой CORS
    if (url.pathname === "/api/stats") {
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      };

      if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
      }

      try {
        const discovery = await getDiscoveryData(keys);
        const stats = await getAnalyticsSnapshot(discovery, keys, env);
        return new Response(JSON.stringify(stats), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            ...corsHeaders,
          },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
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

    // Обработка промптов (/v1/chat/completions, уже по паролю)
    if (url.pathname.endsWith("/chat/completions")) {
      const authResult = authenticate(request, authorizedUsers);
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

      // Читаем тело как сырой текст без блокирующего JSON.parse (экономим CPU на больших чатах)
      let rawBody;
      try {
        rawBody = await request.text();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 });
      }

      try {
        const discovery = await getDiscoveryData(keys);
        return await executeStratifiedRouting(request, rawBody, authResult.user, discovery, discovery.activeKeys, env, ctx);
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
