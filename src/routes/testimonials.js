import { readAdminAccessFromRequest } from "../lib/adminAccess.js";
import { getFintrakUserById } from "../lib/fintrakUsers.js";
import { readSessionFromRequest } from "../lib/serverAuth.js";
import {
  getSupabaseAdmin,
  hasSupabaseAdminConfig,
} from "../lib/supabaseAdmin.js";
import {
  createTestimonialSubmission,
  readHomepageTestimonials,
  readAdminTestimonials,
  readLatestTestimonialSubmission,
  updateAdminTestimonialReview,
  updateTestimonialSubmission,
} from "../lib/testimonials.js";

const MAX_ROLE_LENGTH = 80;
const MAX_LOCATION_LENGTH = 80;
const MAX_QUOTE_LENGTH = 400;
const MIN_QUOTE_LENGTH = 20;

function normalizeString(value) {
  return String(value || "").trim();
}

function buildUnavailableResponse() {
  return {
    available: false,
    submission: null,
  };
}

function validateSubmission(body) {
  const role = normalizeString(body?.role);
  const location = normalizeString(body?.location);
  const quote = normalizeString(body?.quote);
  const consentToPublish = body?.consentToPublish === true;

  if (!quote || quote.length < MIN_QUOTE_LENGTH) {
    return {
      error: `Feedback must be at least ${MIN_QUOTE_LENGTH} characters long.`,
    };
  }

  if (quote.length > MAX_QUOTE_LENGTH) {
    return {
      error: `Feedback must be ${MAX_QUOTE_LENGTH} characters or fewer.`,
    };
  }

  if (role.length > MAX_ROLE_LENGTH) {
    return {
      error: `Role must be ${MAX_ROLE_LENGTH} characters or fewer.`,
    };
  }

  if (location.length > MAX_LOCATION_LENGTH) {
    return {
      error: `Location must be ${MAX_LOCATION_LENGTH} characters or fewer.`,
    };
  }

  if (!consentToPublish) {
    return {
      error: "Please confirm that FinTrak may review and publish your feedback.",
    };
  }

  return {
    role,
    location,
    quote,
    consentToPublish,
    error: null,
  };
}

function buildAuthFailurePayload(access) {
  if (access.reason === "unauthorized") {
    return { status: 401, body: { error: "Unauthorized" } };
  }

  if (access.reason === "forbidden") {
    return { status: 403, body: { error: "Forbidden" } };
  }

  return {
    status: 503,
    body: { error: "Admin moderation is not configured on the server." },
  };
}

function normalizeAction(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeSortOrder(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numeric = Number(value);
  return Number.isInteger(numeric) ? numeric : null;
}

export async function registerTestimonialRoutes(app) {
  app.get("/public/testimonials", async (request, reply) => {
    try {
      if (!hasSupabaseAdminConfig()) {
        return reply.send({
          testimonials: [],
          available: false,
        });
      }

      const { testimonials, error, missingTable } = await readHomepageTestimonials(
        getSupabaseAdmin()
      );

      if (missingTable) {
        return reply.send({
          testimonials: [],
          available: false,
        });
      }

      if (error) {
        request.log.error(
          {
            error,
          },
          "Failed to read approved homepage testimonials."
        );
        return reply.send({
          testimonials: [],
          available: false,
        });
      }

      return reply.send({
        testimonials,
        available: true,
      });
    } catch (error) {
      request.log.error({ error }, "Unexpected homepage testimonial read error.");
      return reply.send({
        testimonials: [],
        available: false,
      });
    }
  });

  app.get("/testimonials", async (request, reply) => {
    try {
      const session = readSessionFromRequest(request);
      if (!session?.id) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      if (!hasSupabaseAdminConfig()) {
        return reply.send(buildUnavailableResponse());
      }

      const { submission, error, missingTable } = await readLatestTestimonialSubmission(
        getSupabaseAdmin(),
        session.id
      );

      if (missingTable) {
        return reply.send(buildUnavailableResponse());
      }

      if (error) {
        request.log.error(
          {
            error,
            sessionUserId: session.id,
          },
          "Failed to read testimonial submission for the authenticated user."
        );
        return reply.code(500).send({
          error: "Could not load your feedback right now.",
        });
      }

      return reply.send({
        available: true,
        submission,
      });
    } catch (error) {
      request.log.error({ error }, "Unexpected testimonial read error.");
      return reply.code(500).send({
        error: "Unexpected feedback load error.",
      });
    }
  });

  app.post("/testimonials", async (request, reply) => {
    try {
      const session = readSessionFromRequest(request);
      if (!session?.id) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      if (!hasSupabaseAdminConfig()) {
        return reply.code(503).send({
          error: "Testimonials are not configured on the server.",
        });
      }

      const validation = validateSubmission(request.body || {});
      if (validation.error) {
        return reply.code(400).send({ error: validation.error });
      }

      const supabase = getSupabaseAdmin();
      const { user, error: userError } = await getFintrakUserById(supabase, session.id);

      if (userError || !user) {
        request.log.error(
          {
            error: userError,
            sessionUserId: session.id,
          },
          "Failed to load the authenticated user before saving feedback."
        );
        return reply.code(500).send({
          error: "Could not verify your account before saving feedback.",
        });
      }

      const existingResult = await readLatestTestimonialSubmission(supabase, session.id);
      if (existingResult.missingTable) {
        return reply.code(503).send({
          error: "Testimonials are not configured on the server.",
        });
      }

      if (existingResult.error) {
        request.log.error(
          {
            error: existingResult.error,
            sessionUserId: session.id,
          },
          "Failed to check existing testimonial feedback before saving."
        );
        return reply.code(500).send({
          error: "Could not save your feedback right now.",
        });
      }

      const payload = {
        role: validation.role,
        location: validation.location,
        quote: validation.quote,
        consentToPublish: validation.consentToPublish,
      };

      const result =
        existingResult.submission && existingResult.submission.status === "pending"
          ? await updateTestimonialSubmission(supabase, existingResult.submission.id, payload)
          : await createTestimonialSubmission(supabase, {
              userId: session.id,
              name: user.username || session.username || "FinTrak user",
              email: user.email || session.email || null,
              ...payload,
            });

      if (result.error || !result.submission) {
        request.log.error(
          {
            error: result.error,
            sessionUserId: session.id,
          },
          "Failed to save testimonial feedback."
        );
        return reply.code(500).send({
          error: "Could not save your feedback right now.",
        });
      }

      return reply.send({
        ok: true,
        submission: result.submission,
      });
    } catch (error) {
      request.log.error({ error }, "Unexpected testimonial save error.");
      return reply.code(500).send({
        error: "Unexpected feedback save error.",
      });
    }
  });

  app.get("/admin/testimonials", async (request, reply) => {
    try {
      const access = await readAdminAccessFromRequest(request);
      if (!access.ok) {
        const failure = buildAuthFailurePayload(access);
        return reply.code(failure.status).send(failure.body);
      }

      const { testimonials, error, missingTable } = await readAdminTestimonials(
        getSupabaseAdmin()
      );

      if (missingTable) {
        return reply.send({ testimonials: [], configured: false });
      }

      if (error) {
        request.log.error(
          {
            error,
            sessionUserId: access.user.id,
          },
          "Failed to read testimonials for admin moderation."
        );
        return reply.code(500).send({
          error: "Could not load testimonial moderation data.",
        });
      }

      return reply.send({
        testimonials,
        configured: true,
      });
    } catch (error) {
      request.log.error({ error }, "Unexpected testimonial moderation read error.");
      return reply.code(500).send({
        error: "Unexpected moderation load error.",
      });
    }
  });

  app.patch("/admin/testimonials", async (request, reply) => {
    try {
      const access = await readAdminAccessFromRequest(request);
      if (!access.ok) {
        const failure = buildAuthFailurePayload(access);
        return reply.code(failure.status).send(failure.body);
      }

      const body = request.body || {};
      const id = String(body?.id || "").trim();
      const action = normalizeAction(body?.action);
      const sortOrder = normalizeSortOrder(body?.sortOrder);

      if (!id) {
        return reply.code(400).send({
          error: "A testimonial id is required.",
        });
      }

      if (!["approve", "reject", "feature", "unfeature"].includes(action)) {
        return reply.code(400).send({
          error: "Unsupported moderation action.",
        });
      }

      const reviewedAt = new Date().toISOString();
      const nextState =
        action === "approve"
          ? {
              approved: true,
              featured: false,
              rejectedAt: null,
              reviewedAt,
              sortOrder,
            }
          : action === "reject"
            ? {
                approved: false,
                featured: false,
                rejectedAt: reviewedAt,
                reviewedAt,
                sortOrder: null,
              }
            : action === "feature"
              ? {
                  approved: true,
                  featured: true,
                  rejectedAt: null,
                  reviewedAt,
                  sortOrder,
                }
              : {
                  approved: true,
                  featured: false,
                  rejectedAt: null,
                  reviewedAt,
                  sortOrder,
                };

      const { submission, error } = await updateAdminTestimonialReview(
        getSupabaseAdmin(),
        id,
        nextState
      );

      if (error || !submission) {
        request.log.error(
          {
            error,
            sessionUserId: access.user.id,
            testimonialId: id,
            action,
          },
          "Failed to apply testimonial moderation action."
        );
        return reply.code(500).send({
          error: "Could not update testimonial moderation state.",
        });
      }

      return reply.send({
        ok: true,
        testimonial: submission,
      });
    } catch (error) {
      request.log.error({ error }, "Unexpected testimonial moderation update error.");
      return reply.code(500).send({
        error: "Unexpected moderation update error.",
      });
    }
  });
}
