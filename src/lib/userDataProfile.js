export const USER_DATA_PROFILE_VERSION = 1;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeCategoryOverrides(value) {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => typeof entry === "string")
  );
}

function normalizeBudgetTargets(value) {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => Number.isFinite(Number(entry)))
  );
}

export function normalizeStoredUserDataProfile(raw) {
  if (
    isRecord(raw) &&
    raw.version === USER_DATA_PROFILE_VERSION &&
    isRecord(raw.categoryOverrides)
  ) {
    return {
      categoryOverrides: normalizeCategoryOverrides(raw.categoryOverrides),
      budgetTargets: normalizeBudgetTargets(raw.budgetTargets),
    };
  }

  return {
    categoryOverrides: normalizeCategoryOverrides(raw),
    budgetTargets: {},
  };
}

export function encodeUserDataProfile({
  categoryOverrides = {},
  budgetTargets = {},
} = {}) {
  return {
    version: USER_DATA_PROFILE_VERSION,
    categoryOverrides: normalizeCategoryOverrides(categoryOverrides),
    budgetTargets: normalizeBudgetTargets(budgetTargets),
  };
}
