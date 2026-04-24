import crypto from "node:crypto";

function getBaseSecret() {
  const appSecret = process.env.APP_SESSION_SECRET;

  if (appSecret) {
    return appSecret;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("APP_SESSION_SECRET must be set in production");
  }

  const fallbackSecret =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.GOOGLE_CLIENT_SECRET;

  if (!fallbackSecret) {
    throw new Error(
      "APP_SESSION_SECRET, SUPABASE_SERVICE_ROLE_KEY, or GOOGLE_CLIENT_SECRET must be set in development"
    );
  }

  return fallbackSecret;
}

export function deriveSecret(label) {
  return crypto
    .createHash("sha256")
    .update(`${label}:${getBaseSecret()}`)
    .digest();
}

export function encryptSecretValue(value) {
  if (!value) {
    return "";
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    deriveSecret("refresh-token-encryption"),
    iv
  );
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptSecretValue(payload) {
  if (!payload) {
    return "";
  }

  const [ivPart, tagPart, encryptedPart] = String(payload).split(".");
  if (!ivPart || !tagPart || !encryptedPart) {
    throw new Error("Encrypted value is malformed");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    deriveSecret("refresh-token-encryption"),
    Buffer.from(ivPart, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, "base64url")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
