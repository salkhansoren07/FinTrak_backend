function normalizeText(value) {
  return String(value || "").trim();
}

function isSupportedField(field) {
  return field === "vpa" || field === "bank";
}

function isSupportedOperator(operator) {
  return operator === "contains" || operator === "equals";
}

function normalizeCategoryRule(rule) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    return null;
  }

  const id = normalizeText(rule.id);
  const field = normalizeText(rule.field).toLowerCase();
  const operator = normalizeText(rule.operator).toLowerCase();
  const value = normalizeText(rule.value);
  const category = normalizeText(rule.category);

  if (!id || !isSupportedField(field) || !isSupportedOperator(operator)) {
    return null;
  }

  if (!value || !category) {
    return null;
  }

  const createdAt =
    rule.createdAt === null || rule.createdAt === undefined
      ? null
      : Number(rule.createdAt);

  return {
    id,
    field,
    operator,
    value,
    category,
    enabled: rule.enabled !== false,
    createdAt: Number.isFinite(createdAt) ? createdAt : null,
  };
}

export function normalizeCategoryRules(rules) {
  if (!Array.isArray(rules)) {
    return [];
  }

  const byId = new Map();

  for (const rule of rules) {
    const normalized = normalizeCategoryRule(rule);
    if (!normalized) {
      continue;
    }

    byId.set(normalized.id, normalized);
  }

  return [...byId.values()];
}
