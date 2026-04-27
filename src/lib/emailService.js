const RESEND_API_URL = "https://api.resend.com/emails";

function normalizeString(value) {
  return String(value || "").trim();
}

export function hasTransactionalEmailConfig() {
  return Boolean(
    normalizeString(process.env.RESEND_API_KEY) &&
      normalizeString(
        process.env.PASSWORD_RESET_EMAIL_FROM || process.env.EMAIL_FROM_ADDRESS
      )
  );
}

export async function sendPasswordResetEmail({ to, resetUrl } = {}) {
  const apiKey = normalizeString(process.env.RESEND_API_KEY);
  const from = normalizeString(
    process.env.PASSWORD_RESET_EMAIL_FROM || process.env.EMAIL_FROM_ADDRESS
  );

  if (!apiKey || !from) {
    throw new Error(
      "RESEND_API_KEY and PASSWORD_RESET_EMAIL_FROM or EMAIL_FROM_ADDRESS must be set"
    );
  }

  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
    body: JSON.stringify({
      from,
      to: [to],
      subject: "Reset your FinTrak password",
      html: `
        <div style="font-family: Arial, sans-serif; color: #0f172a; line-height: 1.6;">
          <h2 style="margin-bottom: 8px;">Reset your FinTrak password</h2>
          <p style="margin-top: 0;">We received a request to reset your FinTrak password.</p>
          <p>
            <a href="${resetUrl}" style="display: inline-block; padding: 12px 18px; border-radius: 12px; background: #2563eb; color: #ffffff; text-decoration: none; font-weight: 600;">
              Reset password
            </a>
          </p>
          <p>If the button does not work, copy and paste this link into your browser:</p>
          <p><a href="${resetUrl}">${resetUrl}</a></p>
          <p>This link expires in 20 minutes and can be used only once.</p>
          <p>If you did not request this, you can safely ignore this email.</p>
        </div>
      `,
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      payload?.message ||
      payload?.error?.message ||
      "Transactional email delivery failed";
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return payload;
}
