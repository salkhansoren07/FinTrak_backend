import { createClient } from "@supabase/supabase-js";

let supabase = null;
let supabaseOverride = null;

export function hasSupabaseAdminConfig() {
  if (supabaseOverride) {
    return true;
  }

  return Boolean(
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export function getSupabaseAdmin() {
  if (supabaseOverride) {
    return supabaseOverride;
  }

  if (supabase) {
    return supabase;
  }

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing");
  }

  supabase = createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });

  return supabase;
}

export function setSupabaseAdminForTests(mockClient) {
  supabaseOverride = mockClient;
}

export function clearSupabaseAdminForTests() {
  supabaseOverride = null;
  supabase = null;
}
