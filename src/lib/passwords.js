import crypto from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(crypto.scrypt);
const KEY_LENGTH = 64;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const derivedKey = await scryptAsync(password, salt, KEY_LENGTH);

  return `scrypt:${salt}:${Buffer.from(derivedKey).toString("base64url")}`;
}

export async function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== "string") {
    return false;
  }

  const [algorithm, salt, digest] = storedHash.split(":");
  if (algorithm !== "scrypt" || !salt || !digest) {
    return false;
  }

  const derivedKey = await scryptAsync(password, salt, KEY_LENGTH);
  const expected = Buffer.from(digest, "base64url");
  const actual = Buffer.from(derivedKey);

  return (
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual)
  );
}
