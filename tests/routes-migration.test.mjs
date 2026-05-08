import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { hashPassword, verifyPassword } from "../src/lib/passwords.js";
import { encodeUserDataProfile } from "../src/lib/userDataProfile.js";
import {
  clearSupabaseAdminForTests,
  setSupabaseAdminForTests,
} from "../src/lib/supabaseAdmin.js";
import {
  createPasswordResetToken,
  resetPasswordResetRequestStateForTests,
} from "../src/lib/passwordReset.js";
import { resetObservabilityRequestStateForTests } from "../src/routes/observability.js";

const originalFetch = global.fetch;

function cloneRow(row) {
  return row ? JSON.parse(JSON.stringify(row)) : row;
}

function pickColumns(row, columns) {
  if (!row || !columns) {
    return cloneRow(row);
  }

  const keys = String(columns)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  return keys.reduce((result, key) => {
    result[key] = row[key];
    return result;
  }, {});
}

function createSupabaseMock({
  users = [],
  passwordResetTokens = [],
  updateError = null,
  insertError = null,
  selectError = null,
} = {}) {
  const state = {
    users: users.map((user) => cloneRow(user)),
    passwordResetTokens: passwordResetTokens.map((token) => cloneRow(token)),
    updateError,
    insertError,
    selectError,
  };

  function matches(row, filters) {
    return filters.every(([column, value]) => row?.[column] === value);
  }

  function getRows(tableName) {
    if (tableName === "fintrak_users") {
      return state.users;
    }

    if (tableName === "password_reset_tokens") {
      return state.passwordResetTokens;
    }

    return null;
  }

  function setRows(tableName, nextRows) {
    if (tableName === "fintrak_users") {
      state.users = nextRows;
    }

    if (tableName === "password_reset_tokens") {
      state.passwordResetTokens = nextRows;
    }
  }

  function createQuery(tableName) {
    const query = {
      action: "select",
      filters: [],
      payload: null,
      selectedColumns: null,
      select(columns) {
        this.selectedColumns = columns;
        return this;
      },
      eq(column, value) {
        this.filters.push([column, value]);
        return this;
      },
      insert(payload) {
        this.action = "insert";
        this.payload = cloneRow(payload);
        return this;
      },
      update(payload) {
        this.action = "update";
        this.payload = cloneRow(payload);
        return this;
      },
      delete() {
        this.action = "delete";
        return this;
      },
      getSelectedRows() {
        const rows = getRows(tableName);

        if (!rows) {
          return { data: null, error: new Error("Unknown table") };
        }

        if (state.selectError) {
          return { data: null, error: state.selectError };
        }

        const filtered = rows.filter((entry) => matches(entry, this.filters));
        return {
          data: filtered.map((row) => pickColumns(row, this.selectedColumns)),
          error: null,
        };
      },
      maybeSingle() {
        const selected = this.getSelectedRows();
        if (selected.error) {
          return { data: null, error: selected.error };
        }

        return {
          data: selected.data[0] || null,
          error: null,
        };
      },
      single() {
        const rows = getRows(tableName);
        if (!rows) {
          return { data: null, error: new Error("Unknown table") };
        }

        if (this.action === "insert") {
          if (state.insertError) {
            return { data: null, error: state.insertError };
          }

          const payload = Array.isArray(this.payload) ? this.payload[0] : this.payload;
          const nextRow = {
            ...cloneRow(payload),
            id: payload?.id || `${tableName}-row-${rows.length + 1}`,
          };
          rows.push(nextRow);
          return {
            data: pickColumns(nextRow, this.selectedColumns),
            error: null,
          };
        }

        if (this.action === "update") {
          if (state.updateError) {
            return { data: null, error: state.updateError };
          }

          const row = rows.find((entry) => matches(entry, this.filters)) || null;
          if (!row) {
            return { data: null, error: new Error("Row not found") };
          }

          Object.assign(row, cloneRow(this.payload));
          return {
            data: pickColumns(row, this.selectedColumns),
            error: null,
          };
        }

        return this.maybeSingle();
      },
      then(resolve) {
        if (this.action === "delete") {
          const rows = getRows(tableName) || [];
          setRows(
            tableName,
            rows.filter((entry) => !matches(entry, this.filters))
          );
          return Promise.resolve({ error: null }).then(resolve);
        }

        if (this.action === "select") {
          return Promise.resolve(this.getSelectedRows()).then(resolve);
        }

        return Promise.resolve(this.single()).then(resolve);
      },
    };

    return query;
  }

  return {
    state,
    from(tableName) {
      return createQuery(tableName);
    },
  };
}

function setBaseEnv() {
  process.env.APP_SESSION_SECRET = "test-session-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  process.env.OBSERVABILITY_LOG_LEVEL = "error";
  process.env.RESEND_API_KEY = "resend-test-key";
  process.env.PASSWORD_RESET_EMAIL_FROM = "FinTrak <no-reply@fintrak.online>";
  process.env.CORS_ORIGINS = "https://www.fintrak.online,http://localhost:3000";
  process.env.FRONTEND_BASE_URL = "https://www.fintrak.online";
  delete process.env.OBSERVABILITY_WEBHOOK_URL;
}

async function withApp(run) {
  const app = buildApp();

  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

async function loginAndGetSessionCookie(app, credentials) {
  const response = await app.inject({
    method: "POST",
    url: "/auth/login",
    headers: {
      "content-type": "application/json",
    },
    payload: credentials,
  });

  assert.equal(response.statusCode, 200);
  assert.ok(response.cookies.length > 0);

  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function resetTestState() {
  clearSupabaseAdminForTests();
  resetPasswordResetRequestStateForTests();
  resetObservabilityRequestStateForTests();
  global.fetch = originalFetch;
}

test.afterEach(() => {
  resetTestState();
});

test("observability route ingests client-side reports", async () => {
  setBaseEnv();

  await withApp(async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/observability",
      headers: {
        origin: "https://www.fintrak.online",
        "content-type": "application/json",
      },
      payload: {
        level: "error",
        event: "client.burst",
        message: "attempt-0",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true });
  });
});

test("observability route rejects cross-origin reports", async () => {
  setBaseEnv();

  await withApp(async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/observability",
      headers: {
        origin: "https://evil.example.com",
        "content-type": "application/json",
      },
      payload: {
        level: "error",
        event: "client.blocked",
        message: "blocked",
      },
    });

    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.json(), { ok: false });
  });
});

test("forgot-password route creates a token and sends a reset email", async () => {
  setBaseEnv();

  const passwordHash = await hashPassword("correct-horse-battery-staple");
  const supabase = createSupabaseMock({
    users: [
      {
        id: "user-forgot",
        username: "aarav",
        email: "forgot@example.com",
        password_hash: passwordHash,
        category_overrides: {},
      },
    ],
    passwordResetTokens: [],
  });

  setSupabaseAdminForTests(supabase);

  let emailRequestBody = null;
  global.fetch = async (_url, options = {}) => {
    emailRequestBody = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return { id: "email-123" };
      },
    };
  };

  await withApp(async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/forgot-password",
      headers: {
        "content-type": "application/json",
        origin: "https://www.fintrak.online",
        "x-forwarded-for": "203.0.113.10",
      },
      payload: {
        email: "forgot@example.com",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(supabase.state.passwordResetTokens.length, 1);
    assert.equal(supabase.state.passwordResetTokens[0].user_id, "user-forgot");
    assert.equal(supabase.state.passwordResetTokens[0].email, "forgot@example.com");
    assert.equal(emailRequestBody.to[0], "forgot@example.com");
    assert.match(emailRequestBody.html, /reset-password\?token=/);
  });
});

test("reset-password route updates the stored password and invalidates reset tokens", async () => {
  setBaseEnv();

  const oldPasswordHash = await hashPassword("old-password-123");
  const supabase = createSupabaseMock({
    users: [
      {
        id: "user-reset",
        username: "meera",
        email: "meera@example.com",
        password_hash: oldPasswordHash,
        category_overrides: {},
      },
    ],
    passwordResetTokens: [],
  });

  setSupabaseAdminForTests(supabase);

  const { token, tokenHash, expiresAt } = createPasswordResetToken();
  supabase.state.passwordResetTokens.push({
    id: "token-row-1",
    user_id: "user-reset",
    email: "meera@example.com",
    token_hash: tokenHash,
    expires_at: expiresAt,
    used_at: null,
    created_at: new Date().toISOString(),
  });

  await withApp(async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/reset-password",
      headers: {
        "content-type": "application/json",
      },
      payload: {
        token,
        password: "new-password-456",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(supabase.state.passwordResetTokens.length, 0);
    assert.equal(
      await verifyPassword(
        "new-password-456",
        supabase.state.users[0].password_hash
      ),
      true
    );
  });
});

test("user-data routes round-trip category rules through the backend profile", async () => {
  setBaseEnv();

  const passwordHash = await hashPassword("correct-horse-battery-staple");
  const supabase = createSupabaseMock({
    users: [
      {
        id: "user-data-1",
        username: "rajiv",
        email: "rajiv@example.com",
        password_hash: passwordHash,
        passcode_hash: null,
        gmail_refresh_token: null,
        gmail_email: null,
        gmail_subject: null,
        is_admin: false,
        category_overrides: encodeUserDataProfile({
          categoryOverrides: { txn1: "Food" },
          budgetTargets: { Food: 5000 },
          categoryRules: [
            {
              id: "rule-1",
              field: "vpa",
              operator: "contains",
              value: "swiggy@ibl",
              category: "Food",
              enabled: true,
            },
          ],
        }),
      },
    ],
  });

  setSupabaseAdminForTests(supabase);

  await withApp(async (app) => {
    const cookie = await loginAndGetSessionCookie(app, {
      identifier: "rajiv",
      password: "correct-horse-battery-staple",
    });

    const readResponse = await app.inject({
      method: "GET",
      url: "/user-data",
      headers: {
        cookie,
      },
    });

    assert.equal(readResponse.statusCode, 200);
    assert.deepEqual(readResponse.json(), {
      categoryOverrides: { txn1: "Food" },
      budgetTargets: { Food: 5000 },
      categoryRules: [
        {
          id: "rule-1",
          field: "vpa",
          operator: "contains",
          value: "swiggy@ibl",
          category: "Food",
          enabled: true,
          createdAt: null,
        },
      ],
      userKey: "user-data-1",
      cloudSyncAvailable: true,
    });

    const writeResponse = await app.inject({
      method: "PUT",
      url: "/user-data",
      headers: {
        cookie,
        "content-type": "application/json",
      },
      payload: {
        categoryOverrides: { txn1: "Shopping" },
        budgetTargets: { Shopping: 2000 },
        categoryRules: [
          {
            id: "rule-2",
            field: "bank",
            operator: "equals",
            value: "HDFC",
            category: "Bills",
            enabled: true,
          },
        ],
      },
    });

    assert.equal(writeResponse.statusCode, 200);
    assert.deepEqual(writeResponse.json(), { ok: true, cloudSyncAvailable: true });
    assert.deepEqual(
      supabase.state.users[0].category_overrides,
      encodeUserDataProfile({
        categoryOverrides: { txn1: "Shopping" },
        budgetTargets: { Shopping: 2000 },
        categoryRules: [
          {
            id: "rule-2",
            field: "bank",
            operator: "equals",
            value: "HDFC",
            category: "Bills",
            enabled: true,
          },
        ],
      })
    );
  });
});
