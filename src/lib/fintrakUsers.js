import crypto from "node:crypto";
import {
  encodeUserDataProfile,
  normalizeStoredUserDataProfile,
} from "./userDataProfile.js";

const TABLE_NAME = "fintrak_users";
const USER_SELECT_COLUMNS =
  "id, username, email, password_hash, passcode_hash, gmail_refresh_token, gmail_email, gmail_subject, category_overrides, is_admin";
const USER_SELECT_COLUMNS_WITHOUT_ADMIN =
  "id, username, email, password_hash, passcode_hash, gmail_refresh_token, gmail_email, gmail_subject, category_overrides";

function isMissingAdminColumn(error) {
  const message = typeof error?.message === "string" ? error.message : "";

  return (
    (error?.code === "42703" || error?.code === "PGRST204") &&
    message.includes("is_admin")
  );
}

function normalizeEmail(email) {
  return email ? String(email).trim().toLowerCase() : "";
}

function normalizeUsername(username) {
  return String(username).trim().toLowerCase();
}

function mapUser(row) {
  if (!row) {
    return null;
  }

  return {
    ...normalizeStoredUserDataProfile(row.category_overrides),
    id: row.id,
    username: row.username,
    email: row.email || null,
    passwordHash: row.password_hash || "",
    passcodeHash: row.passcode_hash || "",
    gmailRefreshToken: row.gmail_refresh_token || null,
    gmailEmail: row.gmail_email || null,
    gmailSubject: row.gmail_subject || null,
    isAdmin: Boolean(row.is_admin),
  };
}

function mapCreatedUser(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    username: row.username,
    email: row.email || null,
    gmailConnected: Boolean(row.gmail_refresh_token),
    hasPasscode: Boolean(row.passcode_hash),
    isAdmin: Boolean(row.is_admin),
  };
}

async function readUserQuery(queryBuilder) {
  const initial = await queryBuilder(USER_SELECT_COLUMNS);

  if (isMissingAdminColumn(initial.error)) {
    const fallback = await queryBuilder(USER_SELECT_COLUMNS_WITHOUT_ADMIN);
    return {
      user: mapUser(fallback.data),
      error: fallback.error,
    };
  }

  return {
    user: mapUser(initial.data),
    error: initial.error,
  };
}

export async function getFintrakUserById(supabase, id) {
  return readUserQuery((columns) =>
    supabase.from(TABLE_NAME).select(columns).eq("id", id).maybeSingle()
  );
}

export async function getFintrakUserByIdentifier(supabase, identifier) {
  const normalized = normalizeUsername(identifier);
  const normalizedEmail = normalizeEmail(identifier);

  const byUsername = await readUserQuery((columns) =>
    supabase
      .from(TABLE_NAME)
      .select(columns)
      .eq("username", normalized)
      .maybeSingle()
  );

  if (byUsername.error || byUsername.user) {
    return byUsername;
  }

  return readUserQuery((columns) =>
    supabase
      .from(TABLE_NAME)
      .select(columns)
      .eq("email", normalizedEmail)
      .maybeSingle()
  );
}

export async function getFintrakUserByEmail(supabase, email) {
  return readUserQuery((columns) =>
    supabase
      .from(TABLE_NAME)
      .select(columns)
      .eq("email", normalizeEmail(email))
      .maybeSingle()
  );
}

export async function createFintrakUser(
  supabase,
  { username, email, passwordHash }
) {
  const normalizedUsername = normalizeUsername(username);
  const normalizedEmail = normalizeEmail(email);

  const { data, error } = await supabase
    .from(TABLE_NAME)
    .insert({
      id: crypto.randomUUID(),
      username: normalizedUsername,
      email: normalizedEmail || null,
      password_hash: passwordHash,
      category_overrides: encodeUserDataProfile(),
    })
    .select("id, username, email, gmail_refresh_token, passcode_hash, is_admin")
    .single();

  return {
    user: mapCreatedUser(data),
    error,
  };
}

export async function isUsernameTaken(supabase, username) {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select("id")
    .eq("username", normalizeUsername(username))
    .maybeSingle();

  return { taken: Boolean(data), error };
}

export async function isEmailTaken(supabase, email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return { taken: false, error: null };
  }

  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select("id")
    .eq("email", normalizedEmail)
    .maybeSingle();

  return { taken: Boolean(data), error };
}

export function normalizeLoginIdentifier(identifier) {
  return String(identifier).trim().toLowerCase();
}

export async function updateFintrakUserGmailConnection(
  supabase,
  { userId, encryptedRefreshToken, gmailEmail, gmailSubject }
) {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .update({
      gmail_refresh_token: encryptedRefreshToken,
      gmail_email: gmailEmail || null,
      gmail_subject: gmailSubject || null,
    })
    .eq("id", userId)
    .select("id, username, email, gmail_refresh_token, passcode_hash, is_admin")
    .single();

  return {
    user: mapCreatedUser(data),
    error,
  };
}

export async function clearFintrakUserGmailConnection(supabase, userId) {
  return supabase
    .from(TABLE_NAME)
    .update({
      gmail_refresh_token: null,
      gmail_email: null,
      gmail_subject: null,
    })
    .eq("id", userId);
}

export async function updateFintrakUserPasscode(supabase, userId, passcodeHash) {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .update({
      passcode_hash: passcodeHash,
    })
    .eq("id", userId)
    .select("id, passcode_hash")
    .single();

  return { data, error };
}

export async function clearFintrakUserPasscode(supabase, userId) {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .update({
      passcode_hash: null,
    })
    .eq("id", userId)
    .select("id, passcode_hash")
    .single();

  return { data, error };
}

export async function updateFintrakUserPassword(supabase, userId, passwordHash) {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .update({
      password_hash: passwordHash,
    })
    .eq("id", userId)
    .select("id, password_hash")
    .single();

  return { data, error };
}

export async function deleteFintrakUserById(supabase, userId) {
  const { error } = await supabase.from(TABLE_NAME).delete().eq("id", userId);
  return { error };
}

export async function updateFintrakUserDataProfile(
  supabase,
  userId,
  { categoryOverrides, budgetTargets, categoryRules }
) {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .update({
      category_overrides: encodeUserDataProfile({
        categoryOverrides,
        budgetTargets,
        categoryRules,
      }),
    })
    .eq("id", userId)
    .select("id, category_overrides")
    .single();

  return { data, error };
}
