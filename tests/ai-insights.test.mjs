import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAiInsightsCacheKey,
  buildFallbackInsights,
  extractJsonObject,
  normalizeAiInsightsPayload,
  normalizeTransactionsForAi,
  summarizeTransactionsForAi,
} from "../src/lib/aiInsights.js";

const sampleTransactions = [
  {
    id: "txn-1",
    amount: 1500,
    type: "Debit",
    bank: "HDFC",
    category: "Food",
    timestamp: 1713551400000,
  },
  {
    id: "txn-2",
    amount: 2500,
    type: "Debit",
    bank: "HDFC",
    category: "Shopping",
    timestamp: 1713465000000,
  },
  {
    id: "txn-3",
    amount: 8000,
    type: "Credit",
    bank: "SBI",
    category: "Other",
    timestamp: 1713378600000,
  },
];

test("ai insight transaction normalization trims and sorts inputs", () => {
  const normalized = normalizeTransactionsForAi([
    sampleTransactions[2],
    sampleTransactions[0],
    { amount: 0, timestamp: Date.now() },
    sampleTransactions[1],
  ]);

  assert.deepEqual(
    normalized.map((entry) => entry.id),
    ["txn-1", "txn-2", "txn-3"]
  );
  assert.equal(normalized[0].date, "2024-04-19");
});

test("transaction summaries compute spend leaders and largest transactions", () => {
  const stats = summarizeTransactionsForAi(normalizeTransactionsForAi(sampleTransactions));

  assert.equal(stats.transactionCount, 3);
  assert.equal(stats.totalDebit, 4000);
  assert.equal(stats.totalCredit, 8000);
  assert.equal(stats.topCategories[0].name, "Shopping");
  assert.equal(stats.largestDebit.amount, 2500);
});

test("json extraction can recover fenced Groq-style responses", () => {
  const parsed = extractJsonObject(`
    Here you go:
    \`\`\`json
    {"overview":"Snapshot","insights":[{"title":"Top spend","detail":"Shopping is leading."}],"actions":["Check large purchases"]}
    \`\`\`
  `);

  assert.equal(parsed.overview, "Snapshot");
  assert.equal(parsed.insights[0].title, "Top spend");
});

test("normalized ai payload falls back when required fields are missing", () => {
  const stats = summarizeTransactionsForAi(normalizeTransactionsForAi(sampleTransactions));

  assert.equal(normalizeAiInsightsPayload({}, stats), null);

  const normalized = normalizeAiInsightsPayload(
    {
      overview: "Spending is concentrated in shopping.",
      insights: [
        { title: "Top spend", detail: "Shopping leads the current view." },
      ],
      actions: [],
    },
    stats
  );

  assert.equal(normalized.overview, "Spending is concentrated in shopping.");
  assert.equal(normalized.actions.length, 3);
});

test("fallback insights and cache keys stay deterministic for the same input", () => {
  const normalized = normalizeTransactionsForAi(sampleTransactions);
  const stats = summarizeTransactionsForAi(normalized);
  const firstKey = buildAiInsightsCacheKey("user-1", normalized);
  const secondKey = buildAiInsightsCacheKey("user-1", normalized);
  const fallback = buildFallbackInsights(stats);

  assert.equal(firstKey, secondKey);
  assert.equal(fallback.insights.length, 3);
  assert.match(fallback.overview, /transactions/);
});
