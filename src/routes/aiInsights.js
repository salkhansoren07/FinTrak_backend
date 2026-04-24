import {
  AI_INSIGHTS_CACHE_TTL_MS,
  buildAiInsightsCacheKey,
  buildAiInsightsPrompt,
  buildFallbackInsights,
  extractJsonObject,
  normalizeAiInsightsPayload,
  normalizeTransactionsForAi,
  summarizeTransactionsForAi,
} from "../lib/aiInsights.js";
import { getGroqClient, getGroqModel, hasGroqConfig } from "../lib/aiClient.js";
import { readSessionFromRequest } from "../lib/serverAuth.js";

const aiInsightsCache = new Map();

function pruneAiInsightsCache(now = Date.now()) {
  for (const [key, entry] of aiInsightsCache.entries()) {
    if (!entry?.savedAt || now - entry.savedAt > AI_INSIGHTS_CACHE_TTL_MS) {
      aiInsightsCache.delete(key);
    }
  }
}

function getCachedInsights(cacheKey) {
  pruneAiInsightsCache();
  return aiInsightsCache.get(cacheKey) || null;
}

function setCachedInsights(cacheKey, payload) {
  pruneAiInsightsCache();
  aiInsightsCache.set(cacheKey, {
    ...payload,
    savedAt: Date.now(),
  });
}

function buildNoDataPayload(enabled) {
  return {
    enabled,
    source: "none",
    overview: "",
    insights: [],
    actions: [],
    warning:
      "Insights appear after FinTrak has enough transactions in the current filter.",
  };
}

export async function registerAiInsightsRoutes(app) {
  app.post("/ai/insights", async (request, reply) => {
    const user = readSessionFromRequest(request);

    if (!user) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const transactions = normalizeTransactionsForAi(request.body?.transactions);
    const forceRefresh = request.body?.forceRefresh === true;

    if (transactions.length === 0) {
      return reply.send(buildNoDataPayload(hasGroqConfig()));
    }

    const stats = summarizeTransactionsForAi(transactions);
    const cacheKey = buildAiInsightsCacheKey(user.id, transactions);
    const cached = forceRefresh ? null : getCachedInsights(cacheKey);

    if (cached) {
      return reply.send({
        ...cached.payload,
        cached: true,
      });
    }

    if (!hasGroqConfig()) {
      const fallbackPayload = {
        ...buildFallbackInsights(stats),
        enabled: false,
        source: "fallback",
        warning: "Add GROQ_API_KEY on the API server to enable Groq-written insights.",
      };

      setCachedInsights(cacheKey, { payload: fallbackPayload });
      return reply.send({
        ...fallbackPayload,
        cached: false,
      });
    }

    try {
      const client = getGroqClient();
      const completion = await client.chat.completions.create({
        model: getGroqModel(),
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You turn structured transaction data into concise dashboard insights. Return JSON only.",
          },
          {
            role: "user",
            content: buildAiInsightsPrompt({ stats, transactions }),
          },
        ],
      });

      const rawContent = completion.choices?.[0]?.message?.content || "";
      const parsed = extractJsonObject(rawContent);
      const normalized = normalizeAiInsightsPayload(parsed, stats);

      if (!normalized) {
        throw new Error("Groq returned an invalid insights payload");
      }

      const payload = {
        ...normalized,
        enabled: true,
        source: "groq",
        model: getGroqModel(),
      };

      setCachedInsights(cacheKey, { payload });
      return reply.send({
        ...payload,
        cached: false,
      });
    } catch (error) {
      request.log.warn(
        {
          error,
          sessionUserId: user.id,
          transactionCount: transactions.length,
        },
        "Failed to generate Groq dashboard insights. Returning fallback insights."
      );

      const fallbackPayload = {
        ...buildFallbackInsights(stats),
        enabled: true,
        source: "fallback",
        warning:
          "Groq insights are temporarily unavailable, so FinTrak is showing a rule-based summary.",
      };

      setCachedInsights(cacheKey, { payload: fallbackPayload });
      return reply.send({
        ...fallbackPayload,
        cached: false,
      });
    }
  });
}
