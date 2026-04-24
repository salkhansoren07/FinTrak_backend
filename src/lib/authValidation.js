export const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,24}$/;
export const USERNAME_REQUIREMENTS_MESSAGE =
  "Username must be 3-24 characters and use only letters, numbers, dots, underscores, or hyphens.";

export function isValidUsername(username) {
  return USERNAME_PATTERN.test(String(username || "").trim());
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}
