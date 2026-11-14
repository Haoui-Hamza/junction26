import request from "supertest";
import { describe, expect, it } from "vitest";
import { configFromEnv, createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { makeClock } from "../src/domain/util.js";

const DEMO_TEXT = "We need 1,000 litres of lactose-free milk delivered by Monday. Find the cheapest option, and combine products if one product doesn't have enough stock.";

function app() {
  const cfg = configFromEnv({ PROVIDER: "local" } as NodeJS.ProcessEnv);
  return createApp(cfg, { db: openDb(":memory:"), clock: makeClock("2026-11-13T09:00:00+02:00") }).app;
}
const AGENT = { Authorization: "Bearer demo-agent-token" };
const APPROVER = { Authorization: "Bearer demo-approver-token" };

describe("judging sequence over the HTTP API", () => {
  it("serves the read-only catalog without exposing demo credentials", async () => {
    const cfg = configFromEnv({ PROVIDER: "local", DEMO_MODE: "false" } as NodeJS.ProcessEnv);
    const a = createApp(cfg, { db: openDb(":memory:"), clock: makeClock("2026-11-13T09:00:00+02:00") }).app;

    const response = await request(a).get("/api/v1/catalog").expect(200);

    expect(response.body.products.map((product: { sku: string }) => product.sku)).toContain("G");
    const config = await request(a).get("/api/v1/config").expect(200);
    expect(config.body.demoActors).toEqual([]);
  });

  it("enables locally simulated order placement with Valio quotes by default", async () => {
    const cfg = configFromEnv({ PROVIDER: "valio" } as NodeJS.ProcessEnv);
    const a = createApp(cfg, { db: openDb(":memory:"), clock: makeClock("2026-11-13T09:00:00+02:00") }).app;

    const response = await request(a).get("/api/v1/config").expect(200);

    expect(response.body.providerMode).toBe("valio");
    expect(response.body.provider.orderMode).toBe("simulated");
    expect(response.body.provider.capabilities.submitOrders).toBe(true);
    expect(response.body.demoActors.map((actor: { role: string }) => actor.role)).toContain("agent");
  });

  it("holds an offer above the parsed hard budget for manager approval without placing it", async () => {
    const a = app();
    const rawText = "1000 liters of vegan milk by Wednesday, withn the budget of 600 euro";
    const parsed = await request(a).post("/api/v1/intake/parse").set(AGENT).send({ text: rawText }).expect(200);
    expect(parsed.body.draft).toMatchObject({
      category: "plant_milk",
      requiredAttributes: ["vegan"],
      latestDeliveryDate: "2026-11-18",
      preferredBudgetCents: 60000,
      budgetIsLimit: true,
    });

    const outcome = await request(a)
      .post("/api/v1/request_order")
      .set(AGENT)
      .send({ request: { ...parsed.body.draft, rawText } })
      .expect(200);

    expect(outcome.body.outcome).toBe("approval_required");
    expect(outcome.body.order.currentRevision.terms.totalCents).toBe(80000);
    expect(outcome.body.reasonCodes.map((reason: { code: string }) => reason.code)).toContain("BUYER_BUDGET_EXCEEDED");
    expect(outcome.body.order.status).toBe("awaiting_approval");
    const provider = await request(a).get("/api/v1/demo/provider").expect(200);
    expect(provider.body.orders).toHaveLength(0);
  });

  it("uses a vegan plant-milk offer and honors the buyer's strict budget", async () => {
    const a = app();
    const response = await request(a)
      .post("/api/v1/request_order")
      .set(AGENT)
      .send({
        request: {
          category: "plant_milk",
          requiredAttributes: ["vegan"],
          quantity: 1100,
          unit: "L",
          latestDeliveryDate: "2026-11-16",
          preferredBudgetCents: 90000,
          budgetIsLimit: true,
        },
      })
      .expect(201);

    expect(response.body.outcome).toBe("submitted");
    expect(response.body.order.currentRevision.terms.totalCents).toBe(88000);
    expect(response.body.order.currentRevision.terms.lines[0]).toMatchObject({ sku: "G", volumeMl: 1100000 });
  });

  it("runs steps 1–4 deterministically", async () => {
    const a = app();

    // Intake: natural language → structured request, Monday resolved in Helsinki.
    const parsed = await request(a).post("/api/v1/intake/parse").set(AGENT).send({ text: DEMO_TEXT }).expect(200);
    expect(parsed.body.draft.latestDeliveryDate).toBe("2026-11-16");
    const request1000 = { ...parsed.body.draft, rawText: DEMO_TEXT };

    // Step 1: 100 L is placed automatically.
    const s1 = await request(a).post("/api/v1/request_order").set(AGENT).send({ request: { ...request1000, quantity: 100 } }).expect(201);
    expect(s1.body.outcome).toBe("submitted");
    expect(s1.body.providerOrderId).toMatch(/^VA-20261113-\d{4}$/);
    const firstId = s1.body.providerOrderId;

    // Step 2: reset, 1,000 L → A covers only 600 L; A+B = €1,240, €160 cheaper than C; approval required.
    await request(a).post("/api/v1/demo/reset").expect(200);
    const cmp = await request(a).post("/api/v1/compare_offers").set(AGENT).send({ request: request1000 }).expect(200);
    expect(cmp.body.notes.join(" ")).toMatch(/Cheapest SKU A .* covers only 600 L of 1,000 L/);
    expect(cmp.body.combined.totalCents).toBe(124000);
    expect(cmp.body.single.totalCents).toBe(140000);
    expect(cmp.body.savingsCents).toBe(16000);
    expect(cmp.body.excluded.map((e: any) => e.sku)).toEqual(["D", "E", "F"]);

    const s2 = await request(a).post("/api/v1/request_order").set(AGENT).send({ request: request1000 }).expect(200);
    expect(s2.body.outcome).toBe("approval_required");
    expect(s2.body.nextAction).toBe("human_approval");
    expect(s2.body.reasonCodes[0].code).toBe("OVER_AUTO_LIMIT");
    const orderId = s2.body.orderId;
    const rev1 = { revision: 1, fingerprint: s2.body.fingerprint };

    // The agent cannot approve its own proposal.
    await request(a).post(`/api/v1/orders/${orderId}/approve`).set(AGENT).send(rev1).expect(403);

    // Step 3: approve €1,240, then B → €14.75 before submission.
    const ap1 = await request(a).post(`/api/v1/orders/${orderId}/approve`).set(APPROVER).send(rev1).expect(200);
    expect(ap1.body.outcome).toBe("approved");
    await request(a).post("/api/v1/demo/set-price").send({ sku: "B", priceCents: 1475 }).expect(200);
    const sub1 = await request(a).post(`/api/v1/orders/${orderId}/submit`).set(APPROVER).send(rev1).expect(200);
    expect(sub1.body.outcome).toBe("requote_required");
    expect(sub1.body.order.currentRevision.terms.totalCents).toBe(131000);
    expect(sub1.body.diff.totalDeltaCents).toBe(7000);
    expect(sub1.body.providerOrderId).toBeNull();
    const rev2 = { revision: 2, fingerprint: sub1.body.fingerprint };

    // Old tab still holding revision 1 is refused with the latest revision.
    const stale = await request(a).post(`/api/v1/orders/${orderId}/approve`).set(APPROVER).send(rev1).expect(409);
    expect(stale.body.error.code).toBe("STALE_REVISION");
    expect(stale.body.latestRevision).toBe(2);

    // Still unplaced until approved.
    const status = await request(a).get(`/api/v1/orders/${orderId}`).set(AGENT).expect(200);
    expect(status.body.status).toBe("requote_required");

    // Step 4: approve and submit €1,310 → exactly one provider order ID, full history.
    await request(a).post(`/api/v1/orders/${orderId}/approve`).set(APPROVER).send(rev2).expect(200);
    const [x, y] = await Promise.all([
      request(a).post(`/api/v1/orders/${orderId}/submit`).set(APPROVER).send(rev2),
      request(a).post(`/api/v1/orders/${orderId}/submit`).set(APPROVER).send(rev2),
    ]);
    const done = await request(a).get(`/api/v1/orders/${orderId}`).set(AGENT).expect(200);
    expect(done.body.outcome).toBe("submitted");
    expect(done.body.providerOrderId).toMatch(/^VA-/);
    expect(done.body.providerOrderId).not.toBe(firstId);
    // Depending on interleaving the duplicate sees "submitting" (in flight) or "submitted" (idempotent replay).
    for (const r of [x, y]) expect(["submitted", "submitting"]).toContain(r.body.outcome);
    expect(new Set([x.body.providerOrderId, y.body.providerOrderId].filter(Boolean)).size).toBeLessThanOrEqual(1);
    const prov = await request(a).get("/api/v1/demo/provider").expect(200);
    expect(prov.body.orders).toHaveLength(1);
    expect(prov.body.orders[0].totalCents).toBe(131000);
    expect(done.body.order.events.map((e: any) => e.action)).toEqual([
      "proposal_created",
      "policy_requires_approval",
      "approved",
      "submission_started",
      "offer_changed",
      "replacement_proposed",
      "approved",
      "submission_started",
      "submitted",
    ]);
  });

  it("allows anonymous search assistance but protects order mutations and never exposes provider credentials", async () => {
    const a = app();
    await request(a).post("/api/v1/compare_offers").send({
      request: { category: "milk", requiredAttributes: ["lactose_free"], quantity: 100, unit: "L", latestDeliveryDate: "2026-11-16" },
    }).expect(200);
    await request(a).post("/api/v1/request_order").send({ request: {} }).expect(401);
    await request(a).post("/api/v1/agent/run").send({ text: DEMO_TEXT }).expect(503);
    await request(a).post("/api/v1/agent/run").set(AGENT).send({ text: DEMO_TEXT }).expect(503);
    const cfg = await request(a).get("/api/v1/config").expect(200);
    expect(JSON.stringify(cfg.body)).not.toMatch(/AIMO_API_KEY|OPENAI_API_KEY/);
    expect(JSON.stringify(cfg.body)).not.toContain("LLM_NOT_CONFIGURED");
    await request(a).get("/openapi.json").expect(200);
  });

  it("loads OpenAI configuration from server environment without exposing its key", async () => {
    const cfg = configFromEnv({
      PROVIDER: "local",
      OPENAI_API_KEY: "server-only-test-key",
      OPENAI_MODEL: "test-model",
    } as NodeJS.ProcessEnv);
    expect(cfg.llm).toEqual({ apiKey: "server-only-test-key", model: "test-model" });

    const a = createApp(cfg, { db: openDb(":memory:"), clock: makeClock("2026-11-13T09:00:00+02:00") }).app;
    const response = await request(a).get("/api/v1/config").expect(200);
    expect(response.body.llm).toEqual({ enabled: true, model: "test-model" });
    expect(JSON.stringify(response.body)).not.toContain("server-only-test-key");
  });

  it("returns no_eligible_offer with a partial option for an impossible quantity", async () => {
    const a = app();
    const r = await request(a)
      .post("/api/v1/request_order")
      .set(AGENT)
      .send({ request: { category: "milk", requiredAttributes: ["lactose_free"], quantity: 2005, unit: "L", latestDeliveryDate: "2026-11-16" } })
      .expect(422);
    expect(r.body.outcome).toBe("no_eligible_offer");
    expect(r.body.reasonCodes[0].code).toBe("INSUFFICIENT_STOCK");
    expect(r.body.partialOptions[0].submittable).toBe(false);
  });
});
