function normalizeServiceUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function readConfidenceThreshold() {
  const configured = Number(process.env.ML_CATEGORY_CONFIDENCE_THRESHOLD || 0.65);
  return Number.isFinite(configured) && configured > 0 ? configured : 0.65;
}

export function getMlServiceUrl() {
  return normalizeServiceUrl(process.env.ML_SERVICE_URL);
}

export function hasMlCategoryServiceConfig() {
  return Boolean(getMlServiceUrl());
}

export function shouldPredictCategoryWithMl(transaction) {
  return (
    transaction?.type === "Debit" &&
    transaction?.category === "Other" &&
    typeof transaction?.mlContext === "string" &&
    transaction.mlContext.trim().length > 0
  );
}

function sanitizeTransaction(transaction, nextCategory) {
  const { mlContext, ...rest } = transaction || {};

  if (typeof nextCategory === "string" && nextCategory.trim()) {
    return {
      ...rest,
      category: nextCategory.trim(),
    };
  }

  return rest;
}

function buildPredictionPayload(transaction) {
  return {
    amount: Number(transaction.amount || 0),
    type: transaction.type || "Unknown",
    bank: transaction.bank || "Other",
    vpa: transaction.vpa || "N/A",
    context: transaction.mlContext || "",
  };
}

function createEmptyPredictionSummary(mlServiceAvailable) {
  return {
    predictionsApplied: 0,
    candidatesConsidered: 0,
    categoryCounts: {},
    mlServiceAvailable,
  };
}

export async function applyMlCategoryPredictions(
  transactions = [],
  { fetchImpl = fetch, requestLog = null } = {}
) {
  const eligibleEntries = transactions
    .map((transaction, index) => ({ transaction, index }))
    .filter(({ transaction }) => shouldPredictCategoryWithMl(transaction));

  if (!eligibleEntries.length || !hasMlCategoryServiceConfig()) {
    return {
      transactions: transactions.map((transaction) => sanitizeTransaction(transaction)),
      ...createEmptyPredictionSummary(hasMlCategoryServiceConfig()),
    };
  }

  try {
    const response = await fetchImpl(`${getMlServiceUrl()}/predict/batch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({
        transactions: eligibleEntries.map(({ transaction }) =>
          buildPredictionPayload(transaction)
        ),
      }),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok || !Array.isArray(payload?.predictions)) {
      throw new Error(
        payload?.error || `ML category prediction failed with status ${response.status}.`
      );
    }

    const threshold = readConfidenceThreshold();
    const byIndex = new Map();
    const categoryCounts = {};

    eligibleEntries.forEach(({ index }, predictionIndex) => {
      const prediction = payload.predictions[predictionIndex];
      const category = String(prediction?.category || "").trim();
      const confidence = Number(prediction?.confidence || 0);

      if (category && Number.isFinite(confidence) && confidence >= threshold) {
        byIndex.set(index, category);
        categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      }
    });

    return {
      transactions: transactions.map((transaction, index) =>
        sanitizeTransaction(transaction, byIndex.get(index))
      ),
      predictionsApplied: byIndex.size,
      candidatesConsidered: eligibleEntries.length,
      categoryCounts,
      mlServiceAvailable: true,
    };
  } catch (error) {
    requestLog?.warn?.(
      {
        error,
      },
      "ML category prediction failed. Falling back to parser categories."
    );

    return {
      transactions: transactions.map((transaction) => sanitizeTransaction(transaction)),
      ...createEmptyPredictionSummary(true),
      candidatesConsidered: eligibleEntries.length,
    };
  }
}
