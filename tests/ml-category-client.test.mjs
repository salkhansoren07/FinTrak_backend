import test from "node:test";
import assert from "node:assert/strict";

import {
  applyMlCategoryPredictions,
  hasMlCategoryServiceConfig,
  shouldPredictCategoryWithMl,
} from "../src/lib/mlCategoryClient.js";

test("ml category client only targets uncertain debit transactions", () => {
  assert.equal(
    shouldPredictCategoryWithMl({
      type: "Debit",
      category: "Other",
      mlContext: "swiggy payment",
    }),
    true
  );
  assert.equal(
    shouldPredictCategoryWithMl({
      type: "Credit",
      category: "Other",
      mlContext: "salary credit",
    }),
    false
  );
  assert.equal(
    shouldPredictCategoryWithMl({
      type: "Debit",
      category: "Food",
      mlContext: "swiggy payment",
    }),
    false
  );
});

test("ml category client upgrades categories when confidence clears the threshold", async () => {
  process.env.ML_SERVICE_URL = "https://ml.example.com";
  process.env.ML_CATEGORY_CONFIDENCE_THRESHOLD = "0.65";

  const {
    transactions,
    predictionsApplied,
    mlServiceAvailable,
    candidatesConsidered,
    categoryCounts,
  } =
    await applyMlCategoryPredictions(
      [
        {
          id: "txn-1",
          amount: 420,
          type: "Debit",
          bank: "HDFC",
          vpa: "swiggy@ibl",
          category: "Other",
          mlContext: "payment to swiggy via upi",
        },
        {
          id: "txn-2",
          amount: 1200,
          type: "Debit",
          bank: "SBI",
          vpa: "friend@upi",
          category: "Transfer",
          mlContext: "upi transfer to friend",
        },
      ],
      {
        fetchImpl: async (url, options) => {
          assert.equal(url, "https://ml.example.com/predict/batch");
          const payload = JSON.parse(options.body);
          assert.equal(payload.transactions.length, 1);
          assert.equal(payload.transactions[0].vpa, "swiggy@ibl");

          return {
            ok: true,
            async json() {
              return {
                predictions: [
                  {
                    category: "Food",
                    confidence: 0.91,
                  },
                ],
              };
            },
          };
        },
      }
    );

  assert.equal(mlServiceAvailable, true);
  assert.equal(predictionsApplied, 1);
  assert.equal(candidatesConsidered, 1);
  assert.deepEqual(categoryCounts, { Food: 1 });
  assert.deepEqual(
    transactions.map((transaction) => ({
      id: transaction.id,
      category: transaction.category,
      hasMlContext: Object.hasOwn(transaction, "mlContext"),
    })),
    [
      { id: "txn-1", category: "Food", hasMlContext: false },
      { id: "txn-2", category: "Transfer", hasMlContext: false },
    ]
  );
});

test("ml category client falls back safely when the service is unavailable", async () => {
  process.env.ML_SERVICE_URL = "https://ml.example.com";
  process.env.ML_CATEGORY_CONFIDENCE_THRESHOLD = "0.65";

  const { transactions, predictionsApplied, candidatesConsidered, categoryCounts } =
    await applyMlCategoryPredictions(
      [
        {
          id: "txn-3",
          amount: 650,
          type: "Debit",
          bank: "Axis",
          vpa: "merchant@upi",
          category: "Other",
          mlContext: "generic merchant payment",
        },
      ],
      {
        fetchImpl: async () => {
          throw new Error("service offline");
        },
      }
    );

  assert.equal(predictionsApplied, 0);
  assert.equal(candidatesConsidered, 1);
  assert.deepEqual(categoryCounts, {});
  assert.equal(transactions[0].category, "Other");
  assert.equal(Object.hasOwn(transactions[0], "mlContext"), false);
});

test("ml category client returns zero candidates when nothing qualifies", async () => {
  delete process.env.ML_SERVICE_URL;

  const { predictionsApplied, candidatesConsidered, categoryCounts, mlServiceAvailable } =
    await applyMlCategoryPredictions([
      {
        id: "txn-4",
        amount: 3000,
        type: "Credit",
        bank: "HDFC",
        vpa: "salary@corp",
        category: "Other",
        mlContext: "salary credit",
      },
    ]);

  assert.equal(predictionsApplied, 0);
  assert.equal(candidatesConsidered, 0);
  assert.deepEqual(categoryCounts, {});
  assert.equal(mlServiceAvailable, false);
});

test.after(() => {
  delete process.env.ML_SERVICE_URL;
  delete process.env.ML_CATEGORY_CONFIDENCE_THRESHOLD;
  assert.equal(hasMlCategoryServiceConfig(), false);
});
