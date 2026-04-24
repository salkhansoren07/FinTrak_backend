import crypto from "node:crypto";

export const MAX_AI_INSIGHT_TRANSACTIONS = 75;
export const AI_INSIGHTS_CACHE_TTL_MS = 10 * 60 * 1000;

function sanitizeText(value, maxLength = 280) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "";
  }

  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3).trim()}...`
    : normalized;
}

function isFiniteAmount(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function buildSortedEntries(totals) {
  return Object.entries(totals || {})
    .filter(([, value]) => Number(value) > 0)
    .sort((left, right) => right[1] - left[1]);
}

export function normalizeTransactionsForAi(transactions = []) {
  if (!Array.isArray(transactions)) {
    return [];
  }

  return transactions
    .filter(
      (transaction) =>
        transaction &&
        typeof transaction === "object" &&
        isFiniteAmount(transaction.amount) &&
        Number.isFinite(Number(transaction.timestamp))
    )
    .map((transaction) => ({
      id: sanitizeText(transaction.id, 80) || crypto.randomUUID(),
      amount: Number(transaction.amount),
      type: transaction.type === "Credit" ? "Credit" : "Debit",
      bank: sanitizeText(transaction.bank, 40) || "Other",
      category: sanitizeText(transaction.category, 40) || "Other",
      date: new Date(Number(transaction.timestamp)).toISOString().slice(0, 10),
      timestamp: Number(transaction.timestamp),
    }))
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, MAX_AI_INSIGHT_TRANSACTIONS);
}

export function summarizeTransactionsForAi(transactions = []) {
  const debitTransactions = transactions.filter(
    (transaction) => transaction.type === "Debit"
  );
  const creditTransactions = transactions.filter(
    (transaction) => transaction.type === "Credit"
  );
  const categoryTotals = {};
  const bankTotals = {};

  for (const transaction of debitTransactions) {
    categoryTotals[transaction.category] =
      Number(categoryTotals[transaction.category] || 0) + transaction.amount;
    bankTotals[transaction.bank] =
      Number(bankTotals[transaction.bank] || 0) + transaction.amount;
  }

  const sortedCategories = buildSortedEntries(categoryTotals);
  const sortedBanks = buildSortedEntries(bankTotals);
  const totalDebit = debitTransactions.reduce(
    (sum, transaction) => sum + transaction.amount,
    0
  );
  const totalCredit = creditTransactions.reduce(
    (sum, transaction) => sum + transaction.amount,
    0
  );

  return {
    transactionCount: transactions.length,
    debitCount: debitTransactions.length,
    creditCount: creditTransactions.length,
    totalDebit,
    totalCredit,
    averageDebit:
      debitTransactions.length > 0 ? totalDebit / debitTransactions.length : 0,
    averageCredit:
      creditTransactions.length > 0 ? totalCredit / creditTransactions.length : 0,
    largestDebit: debitTransactions[0]
      ? debitTransactions.reduce((largest, current) =>
          current.amount > largest.amount ? current : largest
        )
      : null,
    largestCredit: creditTransactions[0]
      ? creditTransactions.reduce((largest, current) =>
          current.amount > largest.amount ? current : largest
        )
      : null,
    topCategories: sortedCategories.slice(0, 3).map(([name, amount]) => ({
      name,
      amount,
    })),
    topBanks: sortedBanks.slice(0, 3).map(([name, amount]) => ({
      name,
      amount,
    })),
  };
}

export function buildAiInsightsCacheKey(userId, transactions = []) {
  const normalizedUserId = sanitizeText(userId, 120) || "anonymous";
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(transactions))
    .digest("hex");

  return `${normalizedUserId}:${digest}`;
}

export function extractJsonObject(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
      try {
        return JSON.parse(fencedMatch[1].trim());
      } catch {
        return null;
      }
    }

    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return null;
    }

    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }
}

function normalizeInsightItem(item) {
  const title = sanitizeText(item?.title, 80);
  const detail = sanitizeText(item?.detail, 180);

  if (!title || !detail) {
    return null;
  }

  return { title, detail };
}

export function normalizeAiInsightsPayload(payload, stats) {
  const overview = sanitizeText(payload?.overview, 320);
  const insights = Array.isArray(payload?.insights)
    ? payload.insights.map(normalizeInsightItem).filter(Boolean).slice(0, 3)
    : [];
  const actions = Array.isArray(payload?.actions)
    ? payload.actions
        .map((entry) => sanitizeText(entry, 160))
        .filter(Boolean)
        .slice(0, 3)
    : [];

  if (!overview || insights.length === 0) {
    return null;
  }

  return {
    overview,
    insights,
    actions:
      actions.length > 0 ? actions : buildFallbackInsights(stats).actions,
  };
}

export function buildFallbackInsights(stats) {
  const topCategory = stats.topCategories[0] || null;
  const topBank = stats.topBanks[0] || null;
  const largestDebit = stats.largestDebit || null;
  const netFlow = stats.totalCredit - stats.totalDebit;
  const insights = [];

  if (topCategory) {
    insights.push({
      title: "Top spend category",
      detail: `${topCategory.name} led spending at ${formatCurrency(topCategory.amount)} in the current view.`,
    });
  }

  if (largestDebit) {
    insights.push({
      title: "Largest outgoing payment",
      detail: `Your biggest debit was ${formatCurrency(largestDebit.amount)}${largestDebit.category ? ` in ${largestDebit.category}` : ""}.`,
    });
  }

  if (topBank) {
    insights.push({
      title: "Most active bank",
      detail: `${topBank.name} handled ${formatCurrency(topBank.amount)} of debit volume in this slice.`,
    });
  }

  return {
    overview: `This view includes ${stats.transactionCount} transactions with ${formatCurrency(stats.totalDebit)} in spending and ${formatCurrency(stats.totalCredit)} in credits.`,
    insights: insights.slice(0, 3),
    actions: [
      topCategory
        ? `Review recent ${topCategory.name.toLowerCase()} spends for repeat charges or easy cuts.`
        : "Review the latest debits to spot a category worth tracking more closely.",
      netFlow < 0
        ? "Spending is ahead of credits in this filter, so check whether this is expected for the period."
        : "Credits are keeping pace with spending in this filter, so focus on your largest debit spikes.",
      "Use the date filter to compare this period against a tighter window before changing budgets.",
    ],
  };
}

export function buildAiInsightsPrompt({ stats, transactions }) {
  return JSON.stringify(
    {
      task: "Create concise financial dashboard insights from pre-parsed transactions.",
      rules: [
        "Return valid JSON only.",
        "Use exactly these top-level keys: overview, insights, actions.",
        "overview must be one sentence under 320 characters.",
        "insights must contain exactly 3 items with title and detail.",
        "actions must contain 2 or 3 short practical suggestions.",
        "Use only the provided data.",
        "Do not mention missing information, compliance disclaimers, or that you are an AI.",
        "Be specific, factual, and concise."
      ],
      stats,
      transactions,
    },
    null,
    2
  );
}
