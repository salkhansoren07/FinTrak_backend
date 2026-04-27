import test from "node:test";
import assert from "node:assert/strict";
import { parseTransaction } from "../src/lib/parseTransaction.js";

function encodeBase64Url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function createEmail({
  subject,
  from,
  body,
  internalDate = "1713551400000",
  id = "message-1",
}) {
  return {
    id,
    internalDate,
    payload: {
      headers: [
        { name: "Subject", value: subject },
        { name: "From", value: from },
      ],
      body: {
        data: encodeBase64Url(body),
      },
      mimeType: "text/plain",
    },
  };
}

test("parser does not label counterparty mentions as the user's bank", () => {
  const transaction = parseTransaction(
    createEmail({
      id: "merchant-1",
      subject: "Payment received for your YourStory membership",
      from: "YourStory Feedback <nslfeedback@yourstory.com>",
      body:
        "Rs 150 paid to nslfeedback@yourstory via UPI. UPI Ref 9988776655. This receipt mentions ICICI support for merchants.",
    })
  );

  assert.ok(transaction);
  assert.equal(transaction.amount, 150);
  assert.equal(transaction.type, "Debit");
  assert.equal(transaction.vpa, "nslfeedback@yourstory");
  assert.equal(transaction.bank, "Other");
});

test("parser keeps the sender bank when the payee VPA contains another bank alias", () => {
  const transaction = parseTransaction(
    createEmail({
      id: "hdfc-1",
      subject: "Rs 300 debited from your HDFC Bank account",
      from: "HDFC Bank Alerts <alerts@hdfcbank.net>",
      body:
        "Your account ending 1234 is debited by Rs 300 to jagannathbesra5@okicici via UPI. UTR 123456789.",
    })
  );

  assert.ok(transaction);
  assert.equal(transaction.amount, 300);
  assert.equal(transaction.type, "Debit");
  assert.equal(transaction.vpa, "jagannathbesra5@okicici");
  assert.equal(transaction.bank, "HDFC");
});
