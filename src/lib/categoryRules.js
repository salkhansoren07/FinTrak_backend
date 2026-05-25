function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeRuleField(field) {
  return normalizeText(field).toLowerCase();
}

function normalizeRuleOperator(operator) {
  return normalizeText(operator).toLowerCase();
}

function normalizeRuleValue(value) {
  return normalizeText(value).toLowerCase();
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
  const field = normalizeRuleField(rule.field);
  const operator = normalizeRuleOperator(rule.operator);
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

function buildCategoryRuleSignature(rule) {
  const field = normalizeRuleField(rule?.field);
  const operator = normalizeRuleOperator(rule?.operator);
  const value = normalizeRuleValue(rule?.value);

  if (!isSupportedField(field) || !isSupportedOperator(operator) || !value) {
    return null;
  }

  return `${field}:${operator}:${value}`;
}

export function normalizeCategoryRules(rules) {
  if (!Array.isArray(rules)) {
    return [];
  }

  const bySignature = new Map();
  const signatureById = new Map();

  for (const rule of rules) {
    const normalized = normalizeCategoryRule(rule);
    if (!normalized) {
      continue;
    }

    const signature = buildCategoryRuleSignature(normalized);
    if (!signature) {
      continue;
    }

    const priorSignature = signatureById.get(normalized.id);
    if (priorSignature) {
      bySignature.delete(priorSignature);
    }

    bySignature.delete(signature);
    bySignature.set(signature, normalized);
    signatureById.set(normalized.id, signature);
  }

  return [...bySignature.values()];
}
