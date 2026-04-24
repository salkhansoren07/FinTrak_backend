const TESTIMONIALS_TABLE = "testimonials";
const DEFAULT_TESTIMONIAL_LIMIT = 3;

function normalizeString(value) {
  return String(value || "").trim();
}

export function buildTestimonialMeta({ role, location } = {}) {
  return [normalizeString(role), normalizeString(location)]
    .filter(Boolean)
    .join(", ");
}

export function normalizeTestimonialSubmission(row) {
  const name = normalizeString(row?.name);
  const quote = normalizeString(row?.quote);

  if (!name || !quote) {
    return null;
  }

  return {
    id: normalizeString(row?.id) || `${name}:${quote}`,
    name,
    email: normalizeString(row?.email) || null,
    role: normalizeString(row?.role) || "",
    location: normalizeString(row?.location) || "",
    quote,
    meta: buildTestimonialMeta(row),
    avatarUrl: normalizeString(row?.avatar_url) || null,
    approved: Boolean(row?.approved),
    status: row?.rejected_at ? "rejected" : row?.approved ? "approved" : "pending",
    featured: Boolean(row?.featured),
    consentToPublish: Boolean(row?.consent_to_publish),
    rejectedAt: row?.rejected_at || null,
    reviewedAt: row?.reviewed_at || null,
    createdAt: row?.created_at || null,
    updatedAt: row?.updated_at || null,
  };
}

function isMissingTestimonialsTable(error) {
  const message = normalizeString(error?.message).toLowerCase();

  return (
    (error?.code === "42P01" || error?.code === "PGRST205") &&
    message.includes(TESTIMONIALS_TABLE)
  );
}

export async function readLatestTestimonialSubmission(supabase, userId) {
  const normalizedUserId = normalizeString(userId);
  if (!normalizedUserId) {
    return {
      submission: null,
      error: null,
      missingTable: false,
    };
  }

  const { data, error } = await supabase
    .from(TESTIMONIALS_TABLE)
    .select(
      "id, user_id, name, email, role, location, quote, avatar_url, approved, featured, consent_to_publish, rejected_at, reviewed_at, created_at, updated_at"
    )
    .eq("user_id", normalizedUserId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (isMissingTestimonialsTable(error)) {
    return {
      submission: null,
      error: null,
      missingTable: true,
    };
  }

  const row = Array.isArray(data) ? data[0] || null : null;

  return {
    submission: normalizeTestimonialSubmission(row),
    error,
    missingTable: false,
  };
}

export async function readHomepageTestimonials(
  supabase,
  { limit = DEFAULT_TESTIMONIAL_LIMIT } = {}
) {
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_TESTIMONIAL_LIMIT;

  const { data, error } = await supabase
    .from(TESTIMONIALS_TABLE)
    .select("id, name, role, location, quote, avatar_url, featured, sort_order, created_at")
    .eq("approved", true)
    .order("featured", { ascending: false })
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (isMissingTestimonialsTable(error)) {
    return {
      testimonials: [],
      error: null,
      missingTable: true,
    };
  }

  return {
    testimonials: Array.isArray(data)
      ? data
          .map((row) => {
            const submission = normalizeTestimonialSubmission(row);
            if (!submission) {
              return null;
            }

            return {
              id: submission.id,
              name: submission.name,
              quote: submission.quote,
              meta: submission.meta,
              avatarUrl: submission.avatarUrl,
            };
          })
          .filter(Boolean)
      : [],
    error,
    missingTable: false,
  };
}

export async function createTestimonialSubmission(
  supabase,
  { userId, name, email, role, location, quote, consentToPublish }
) {
  const timestamp = new Date().toISOString();

  const { data, error } = await supabase
    .from(TESTIMONIALS_TABLE)
    .insert({
      user_id: normalizeString(userId),
      name: normalizeString(name),
      email: normalizeString(email) || null,
      role: normalizeString(role) || null,
      location: normalizeString(location) || null,
      quote: normalizeString(quote),
      consent_to_publish: Boolean(consentToPublish),
      approved: false,
      featured: false,
      rejected_at: null,
      reviewed_at: null,
      submission_source: "in_app",
      created_at: timestamp,
      updated_at: timestamp,
    })
    .select(
      "id, user_id, name, email, role, location, quote, avatar_url, approved, featured, consent_to_publish, rejected_at, reviewed_at, created_at, updated_at"
    )
    .single();

  return {
    submission: normalizeTestimonialSubmission(data),
    error,
  };
}

export async function updateTestimonialSubmission(
  supabase,
  submissionId,
  { role, location, quote, consentToPublish }
) {
  const { data, error } = await supabase
    .from(TESTIMONIALS_TABLE)
    .update({
      role: normalizeString(role) || null,
      location: normalizeString(location) || null,
      quote: normalizeString(quote),
      consent_to_publish: Boolean(consentToPublish),
      approved: false,
      featured: false,
      rejected_at: null,
      reviewed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", normalizeString(submissionId))
    .select(
      "id, user_id, name, email, role, location, quote, avatar_url, approved, featured, consent_to_publish, rejected_at, reviewed_at, created_at, updated_at"
    )
    .single();

  return {
    submission: normalizeTestimonialSubmission(data),
    error,
  };
}

export async function readAdminTestimonials(supabase, { limit = 50 } = {}) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 50;

  const { data, error } = await supabase
    .from(TESTIMONIALS_TABLE)
    .select(
      "id, user_id, name, email, role, location, quote, avatar_url, approved, featured, consent_to_publish, rejected_at, reviewed_at, submission_source, sort_order, created_at, updated_at"
    )
    .order("approved", { ascending: true })
    .order("rejected_at", { ascending: true })
    .order("featured", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (isMissingTestimonialsTable(error)) {
    return {
      testimonials: [],
      error: null,
      missingTable: true,
    };
  }

  const testimonials = Array.isArray(data)
    ? data
        .map((row) => {
          const normalized = normalizeTestimonialSubmission(row);
          if (!normalized) {
            return null;
          }

          if (row?.rejected_at) {
            return {
              ...normalized,
              status: "rejected",
            };
          }

          return normalized;
        })
        .filter(Boolean)
    : [];

  return {
    testimonials,
    error,
    missingTable: false,
  };
}

export async function updateAdminTestimonialReview(
  supabase,
  testimonialId,
  { approved, featured, rejectedAt, reviewedAt, sortOrder = null }
) {
  const { data, error } = await supabase
    .from(TESTIMONIALS_TABLE)
    .update({
      approved: Boolean(approved),
      featured: Boolean(featured),
      rejected_at: rejectedAt,
      reviewed_at: reviewedAt,
      sort_order: sortOrder,
      updated_at: new Date().toISOString(),
    })
    .eq("id", normalizeString(testimonialId))
    .select(
      "id, user_id, name, email, role, location, quote, avatar_url, approved, featured, consent_to_publish, rejected_at, reviewed_at, created_at, updated_at"
    )
    .single();

  return {
    submission: normalizeTestimonialSubmission(data),
    error,
  };
}
