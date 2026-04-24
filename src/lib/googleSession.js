import { decryptSecretValue, encryptSecretValue } from "./serverSecrets.js";
import { refreshGoogleAccessToken } from "./googleOAuth.js";
import {
  clearFintrakUserGmailConnection,
  getFintrakUserById,
  updateFintrakUserGmailConnection,
} from "./fintrakUsers.js";

function buildReconnectError(message) {
  const error = new Error(message);
  error.status = 401;
  return error;
}

export async function getServerGmailAccessToken(supabase, sessionUser) {
  const { user, error } = await getFintrakUserById(supabase, sessionUser.id);

  if (error) {
    throw error;
  }

  if (!user?.gmailRefreshToken) {
    throw buildReconnectError(
      "Gmail is not connected for this FinTrak account. Please connect Gmail again."
    );
  }

  let refreshToken = "";

  try {
    refreshToken = decryptSecretValue(user.gmailRefreshToken);
  } catch {
    throw buildReconnectError(
      "The saved Gmail connection could not be read. Please connect Gmail again."
    );
  }

  try {
    const tokens = await refreshGoogleAccessToken(refreshToken);

    if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
      await updateFintrakUserGmailConnection(supabase, {
        userId: sessionUser.id,
        encryptedRefreshToken: encryptSecretValue(tokens.refresh_token),
        gmailEmail: user.gmailEmail,
        gmailSubject: user.gmailSubject,
      });
    }

    if (!tokens.access_token) {
      throw new Error("Google did not return an access token");
    }

    return tokens.access_token;
  } catch (error) {
    const message = error?.message || "Failed to refresh Gmail access";
    if (
      error?.status === 400 ||
      message.includes("invalid_grant") ||
      message.includes("Token has been expired or revoked")
    ) {
      await clearFintrakUserGmailConnection(supabase, sessionUser.id).catch(
        () => null
      );
      throw buildReconnectError(
        "Your Gmail connection has expired or was revoked. Please connect Gmail again."
      );
    }

    throw error;
  }
}
