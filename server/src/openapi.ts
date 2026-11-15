const demoRequest = {
  rawText: "Get 1,000 litres of lactose-free milk delivered by Monday. Keep it under €1,200 if possible.",
  category: "milk",
  requiredAttributes: ["lactose_free"],
  quantity: 1000,
  unit: "L",
  latestDeliveryDate: "2026-11-16",
  preferredBudgetCents: 120000,
  budgetIsLimit: false,
  requestedSku: null,
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown, example?: unknown) => ({ content: { "application/json": { schema, ...(example ? { example } : {}) } } });
const errors = {
  "400": { description: "Validation failed", ...json(ref("Error")) },
  "401": { description: "Missing or invalid bearer token", ...json(ref("Error")) },
  "403": { description: "Actor's role may not perform this action", ...json(ref("Error")) },
};
const revisionBody = {
  required: true,
  ...json(ref("RevisionRef"), { revision: 1, fingerprint: "3f1c…(64 hex chars from get_order_status)", reason: "Within weekly milk budget" }),
};

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Aimo Order Guard API",
    version: "0.1.0",
    description:
      "Purchasing-agent API for the Valio Aimo Trusted Trade Agents challenge. Agents may search, compare, request orders and read status. " +
      "Human approval (approve/reject) requires the approver role and is bound to an immutable revision fingerprint. " +
      "Money is integer euro cents, volume integer millilitres, packs integer counts. Authenticate with `Authorization: Bearer <token>`.",
  },
  servers: [{ url: "/api/v1" }],
  security: [{ bearer: [] }],
  paths: {
    "/assistant/classify": {
      post: { operationId: "classify_request", summary: "Route a request to the milk or ingredient-basket workflow", security: [], requestBody: { required: true, ...json({ type: "object", required: ["text"], properties: { text: { type: "string" } } }) }, responses: { "200": { description: "Request kind and extracted date and budget hints" }, ...errors } },
    },
    "/baskets/suggest": {
      post: { operationId: "suggest_ingredients", summary: "Estimate essential ingredients for buyer review", security: [], requestBody: { required: true, ...json({ type: "object", required: ["text", "servings"], properties: { text: { type: "string" }, servings: { type: "integer", minimum: 1 } } }) }, responses: { "200": { description: "Suggested ingredients, estimated grams and explanation" }, ...errors } },
    },
    "/baskets/recommend": {
      post: { operationId: "recommend_ingredient_products", summary: "Select matching products and whole-pack quantities for reviewed ingredients", security: [], requestBody: { required: true, ...json({ type: "object", required: ["deliveryDate", "dietaryNotes", "ingredients"], properties: { deliveryDate: { type: "string", format: "date" }, dietaryNotes: { type: "string" }, ingredients: { type: "array", items: { type: "object", required: ["name", "grams"], properties: { name: { type: "string" }, grams: { type: "integer", minimum: 1 } } } } } }) }, responses: { "200": { description: "Product recommendations or explicit missing matches" }, ...errors } },
    },
    "/baskets/search": {
      post: { operationId: "search_ingredients", summary: "Search and quote up to 100 matching Valio catalog products", security: [], requestBody: { required: true, ...json({ type: "object", required: ["query", "deliveryDate"], properties: { query: { type: "string" }, deliveryDate: { type: "string", format: "date" } } }) }, responses: { "200": { description: "Available matching products; terminal stock is unconfirmed" }, ...errors } },
    },
    "/baskets/preview": {
      post: { operationId: "preview_ingredient_basket", summary: "Requote selected products and produce fingerprinted basket terms", security: [], requestBody: { required: true, ...json({ type: "object", required: ["description", "deliveryDate", "dietaryNotes", "budgetCents", "budgetIsLimit", "lines"], properties: { description: { type: "string" }, deliveryDate: { type: "string", format: "date" }, dietaryNotes: { type: "string" }, budgetCents: { type: ["integer", "null"] }, budgetIsLimit: { type: "boolean" }, lines: { type: "array", items: { type: "object", required: ["ingredient", "sku", "packs"], properties: { ingredient: { type: "string" }, sku: { type: "string" }, packs: { type: "integer", minimum: 1 }, requiredGrams: { type: "integer", minimum: 1, description: "Approved ingredient weight; selected packs must cover it using verified catalog pack weights." } } } } } }) }, responses: { "200": { description: "Basket terms, approval reasons and fingerprint" }, ...errors } },
    },
    "/baskets": {
      get: { operationId: "list_ingredient_baskets", summary: "List saved ingredient baskets", responses: { "200": { description: "Saved baskets" }, ...errors } },
      post: { operationId: "create_ingredient_basket", summary: "Confirm previously reviewed basket terms", requestBody: { required: true, ...json({ type: "object", required: ["input", "fingerprint"], properties: { input: { type: "object" }, fingerprint: { type: "string" } } }) }, responses: { "200": { description: "Approved or awaiting manager approval" }, "409": { description: "Terms changed or simulation disabled" }, ...errors } },
    },
    "/baskets/{id}": {
      get: { operationId: "get_ingredient_basket", summary: "Retrieve a saved basket", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Basket status" }, ...errors } },
    },
    ...Object.fromEntries(["approve", "reject", "submit"].map((action) => [`/baskets/{id}/${action}`, {
      post: { operationId: `${action}_ingredient_basket`, summary: `${action} a basket using its reviewed fingerprint`, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, ...json({ type: "object", required: ["fingerprint"], properties: { fingerprint: { type: "string" } } }) }, responses: { "200": { description: "Updated basket" }, "409": { description: "Stale terms or invalid basket status" }, ...errors } },
    }])),
    "/catalog": {
      get: {
        operationId: "list_available_products",
        summary: "List currently quoted products for a one-week delivery window",
        security: [],
        responses: { "200": { description: "Products with current prices, availability and delivery dates" }, ...errors },
      },
    },
    "/search_products": {
      post: {
        operationId: "search_products",
        summary: "Structured product, price, stock and delivery lookup for a request",
        security: [],
        requestBody: { required: true, ...json({ type: "object", properties: { request: ref("PurchaseRequest") } }, { request: demoRequest }) },
        responses: { "200": { description: "Offers with eligibility", ...json(ref("SearchResult")) }, ...errors },
      },
    },
    "/compare_offers": {
      post: {
        operationId: "compare_offers",
        summary: "Ranked best single-SKU and best combined (exact whole-pack) options",
        security: [],
        requestBody: { required: true, ...json({ type: "object", properties: { request: ref("PurchaseRequest") } }, { request: demoRequest }) },
        responses: { "200": { description: "Comparison", ...json(ref("Comparison")) }, ...errors },
      },
    },
    "/request_order": {
      post: {
        operationId: "request_order",
        summary: "Create a proposal, evaluate policy, then simulate submission or route to human approval",
        requestBody: {
          required: true,
          ...json(
            {
              type: "object",
              required: ["request"],
              properties: {
                request: ref("PurchaseRequest"),
                option: { type: "string", enum: ["recommended", "single", "combined"], default: "recommended" },
                clientRequestId: { type: "string", description: "Idempotency key for the agent's request; repeats return the same order" },
              },
            },
            { request: demoRequest, option: "recommended", clientRequestId: "kitchen-agent-2026-11-13-001" },
          ),
        },
        responses: {
          "200": { description: "approval_required / requote_required / submission_outcome_unknown", ...json(ref("Outcome")) },
          "201": { description: "submitted", ...json(ref("Outcome")) },
          "422": { description: "no_eligible_offer (with partial options, never submittable)", ...json(ref("Outcome")) },
          ...errors,
        },
      },
    },
    "/orders/{id}": {
      get: {
        operationId: "get_order_status",
        summary: "Current revision, outcome, next action, history and provider order ID",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, example: "PO-0002" }],
        responses: { "200": { description: "Status", ...json(ref("Outcome")) }, "404": { description: "Not found", ...json(ref("Error")) }, ...errors },
      },
    },
    "/orders": { get: { operationId: "list_orders", summary: "List orders", responses: { "200": { description: "Orders" } } } },
    "/orders/{id}/approve": {
      post: {
        operationId: "approve_order",
        summary: "Human approval of an exact revision (approver role only). Fails with 409 STALE_REVISION for an older revision.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: revisionBody,
        responses: { "200": { description: "approved or requote_required", ...json(ref("Outcome")) }, "409": { description: "Stale revision / invalid state", ...json(ref("Error")) }, ...errors },
      },
    },
    "/orders/{id}/reject": {
      post: {
        operationId: "reject_order",
        summary: "Human rejection (approver role only)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: revisionBody,
        responses: { "200": { description: "rejected", ...json(ref("Outcome")) }, "409": { description: "Stale revision", ...json(ref("Error")) }, ...errors },
      },
    },
    "/orders/{id}/submit": {
      post: {
        operationId: "submit_order",
        summary: "Revalidate and submit an approved revision. Idempotent per revision; duplicate/concurrent calls return the same outcome.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: revisionBody,
        responses: { "200": { description: "submitted / requote_required / submission_outcome_unknown", ...json(ref("Outcome")) }, "409": { description: "Stale or not approved", ...json(ref("Error")) }, ...errors },
      },
    },
    "/orders/{id}/reconcile": {
      post: {
        operationId: "reconcile_order",
        summary: "Resolve submission_outcome_unknown by looking up the submission key at the provider",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Outcome", ...json(ref("Outcome")) } },
      },
    },
    "/intake/parse": {
      post: {
        operationId: "parse_request",
        summary: "Natural language → structured request (LLM if configured, otherwise rules). Returns one targeted question when something is missing.",
        security: [],
        requestBody: { required: true, ...json({ type: "object", properties: { text: { type: "string" } } }, { text: demoRequest.rawText }) },
        responses: { "200": { description: "Draft request" } },
      },
    },
    "/agent/run": {
      post: {
        operationId: "run_purchasing_agent",
        summary: "Run the configured LLM purchasing agent with live MCP tool calls and streamed activity",
        security: [],
        description:
          "Streams Server-Sent Events for interpretation, MCP tool calls/results, clarification, errors, and the final agent summary. Requires OPENAI_API_KEY.",
        requestBody: {
          required: true,
          ...json({ type: "object", required: ["text"], properties: { text: { type: "string", maxLength: 2000 } } }, { text: demoRequest.rawText }),
        },
        responses: {
          "200": { description: "Server-Sent Events stream (text/event-stream)" },
          "401": { description: "Missing or invalid bearer token", ...json(ref("Error")) },
          "403": { description: "Actor may not run the purchasing agent", ...json(ref("Error")) },
          "429": { description: "Anonymous request limit reached", ...json(ref("Error")) },
          "503": { description: "LLM is not configured", ...json(ref("Error")) },
        },
      },
    },
  },
  components: {
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    schemas: {
      PurchaseRequest: {
        type: "object",
        required: ["category", "quantity", "unit", "latestDeliveryDate"],
        additionalProperties: false,
        properties: {
          rawText: { type: ["string", "null"] },
          category: { type: "string", enum: ["milk", "plant_milk"] },
          requiredAttributes: { type: "array", items: { type: "string", enum: ["lactose_free", "organic", "vegan"] } },
          quantity: { type: "number", description: "Quantity in litres" },
          unit: { type: "string", const: "L" },
          latestDeliveryDate: { type: "string", format: "date", description: "Latest acceptable delivery date (Europe/Helsinki)" },
          preferredBudgetCents: { type: ["integer", "null"], description: "Buyer budget in euro cents." },
          budgetIsLimit: { type: "boolean", description: "When true, exceeding the buyer's budget requires manager approval. The service's automatic spending limit is a separate policy." },
          requestedSku: { type: ["string", "null"], description: "Explicit SKU; prevents substitution" },
        },
        example: demoRequest,
      },
      Offer: {
        type: "object",
        properties: {
          sku: { type: "string" },
          name: { type: "string" },
          category: { type: "string" },
          attributes: { type: "object", additionalProperties: { type: ["boolean", "null"] } },
          evidence: { type: "object", additionalProperties: { type: "string" } },
          packVolumeMl: { type: ["integer", "null"] },
          priceCents: { type: ["integer", "null"] },
          currency: { type: "string", const: "EUR" },
          availablePacks: { type: "integer" },
          deliveryDate: { type: ["string", "null"], format: "date" },
          closingTime: { type: ["string", "null"] },
          salesBlock: { type: "boolean" },
          offerVersion: { type: "string" },
        },
      },
      ReasonCode: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
      OptionLine: {
        type: "object",
        properties: {
          sku: { type: "string" },
          name: { type: "string" },
          packs: { type: "integer" },
          packVolumeMl: { type: "integer" },
          volumeMl: { type: "integer" },
          unitPriceCents: { type: "integer" },
          lineTotalCents: { type: "integer" },
          deliveryDate: { type: "string", format: "date" },
        },
      },
      OrderOption: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["single", "combined", "partial_shortfall", "partial_excess"] },
          lines: { type: "array", items: ref("OptionLine") },
          totalCents: { type: "integer" },
          volumeMl: { type: "integer" },
          currency: { type: "string" },
          latestDeliveryDate: { type: "string" },
          qualifies: { type: "array", items: { type: "string" } },
          submittable: { type: "boolean" },
        },
      },
      SearchResult: {
        type: "object",
        properties: {
          request: ref("PurchaseRequest"),
          provider: { type: "string" },
          offers: { type: "array", items: ref("Offer") },
          eligibleSkus: { type: "array", items: { type: "string" } },
          excluded: { type: "array", items: { type: "object", properties: { sku: { type: "string" }, name: { type: "string" }, reasons: { type: "array", items: ref("ReasonCode") } } } },
        },
      },
      Comparison: {
        type: "object",
        properties: {
          single: { oneOf: [ref("OrderOption"), { type: "null" }] },
          combined: { oneOf: [ref("OrderOption"), { type: "null" }] },
          recommended: { oneOf: [ref("OrderOption"), { type: "null" }] },
          recommendedKind: { type: ["string", "null"] },
          savingsCents: { type: ["integer", "null"] },
          contributions: { type: "array", items: { type: "object" } },
          excluded: { type: "array", items: { type: "object" } },
          noFill: { oneOf: [ref("ReasonCode"), { type: "null"}] },
          partialOptions: { type: "array", items: ref("OrderOption") },
          notes: { type: "array", items: { type: "string" } },
        },
      },
      RevisionRef: {
        type: "object",
        required: ["revision", "fingerprint"],
        properties: { revision: { type: "integer" }, fingerprint: { type: "string" }, reason: { type: "string" } },
      },
      Outcome: {
        type: "object",
        required: ["outcome", "message", "reasonCodes", "nextAction"],
        properties: {
          outcome: {
            type: "string",
            enum: ["submitted", "approval_required", "approved", "requote_required", "no_eligible_offer", "submission_outcome_unknown", "submitting", "rejected", "submission_failed"],
          },
          message: { type: "string" },
          reasonCodes: { type: "array", items: ref("ReasonCode") },
          nextAction: { type: ["string", "null"], enum: ["human_approval", "human_approval_of_new_revision", "submit", "reconcile", "revise_request", "poll_status", null] },
          orderId: { type: "string" },
          status: { type: "string", enum: ["proposed", "awaiting_approval", "approved", "requote_required", "submitting", "submitted", "submission_unknown", "rejected", "returned_to_buyer"] },
          revision: { type: "integer" },
          fingerprint: { type: "string" },
          providerOrderId: { type: ["string", "null"] },
          diff: { type: ["object", "null"] },
          order: { type: "object", description: "Full order view: revisions, approvals, submissions, decision history" },
        },
        example: {
          outcome: "approval_required",
          message: "Approval required: Total €1,240.00 exceeds the automatic spending limit of €1,200.00 by €40.00",
          reasonCodes: [{ code: "OVER_AUTO_LIMIT", message: "Total €1,240.00 exceeds the automatic spending limit of €1,200.00 by €40.00" }],
          nextAction: "human_approval",
          orderId: "PO-0001",
          status: "awaiting_approval",
          revision: 1,
          providerOrderId: null,
        },
      },
      Error: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } } },
    },
  },
};
