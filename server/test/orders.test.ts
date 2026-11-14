import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../src/domain/policy.js";
import { fingerprintTerms } from "../src/domain/terms.js";
import type { OrderTerms } from "../src/domain/types.js";
import { DEFAULT_POLICY, OrderService, ServiceError } from "../src/orders.js";
import { DEMO_SEED, LocalProvider } from "../src/providers/local.js";
import { agent, approver, body, buyer, MONDAY, req, setup } from "./helpers.js";

function terms(totalCents: number): OrderTerms {
  return {
    currency: "EUR",
    lines: [{ sku: "A", name: "A", packs: 1, packVolumeMl: 10000, volumeMl: 10000, unitPriceCents: totalCents, lineTotalCents: totalCents, deliveryDate: MONDAY }],
    totalCents,
    volumeMl: 10000,
    latestDeliveryDate: MONDAY,
    deliveryDeadline: MONDAY,
  };
}

async function expectServiceError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ServiceError);
    expect((e as ServiceError).code).toBe(code);
    return e as ServiceError;
  }
  throw new Error(`expected ${code}`);
}

describe("spend-limit boundary", () => {
  it("adds new demo products to an existing database without resetting existing stock", async () => {
    const oldSeed = DEMO_SEED.filter((item) => item.sku !== "G");
    const { db, clock } = setup(oldSeed);
    const oldProvider = new LocalProvider(db, clock, oldSeed);
    oldProvider.setStock("A", 37);

    const upgradedProvider = new LocalProvider(db, clock);
    const service = new OrderService(db, upgradedProvider, clock);
    const catalog = await service.listCatalog();

    expect(upgradedProvider.listOffers().find((offer) => offer.sku === "A")?.availablePacks).toBe(37);
    expect(catalog.products.map((product) => product.sku)).toContain("G");
  });

  it("auto-submits at exactly €1,200.00 and requires approval at €1,200.01", () => {
    expect(evaluatePolicy(DEFAULT_POLICY, terms(120000), req(10)).decision).toBe("auto_submit");
    const over = evaluatePolicy(DEFAULT_POLICY, terms(120001), req(10));
    expect(over.decision).toBe("approval_required");
    expect(over.reasons[0].code).toBe("OVER_AUTO_LIMIT");
  });

  it("keeps a soft budget target separate from policy and enforces a stated budget limit", () => {
    // Buyer typing a €5,000 budget does not raise the automatic limit.
    expect(evaluatePolicy(DEFAULT_POLICY, terms(130000), req(10, { preferredBudgetCents: 500000 })).decision).toBe("approval_required");
    // A low target is a preference; the same amount stated as a limit requires approval to exceed.
    const d = evaluatePolicy(DEFAULT_POLICY, terms(110000), req(10, { preferredBudgetCents: 100000 }));
    expect(d.decision).toBe("auto_submit");
    expect(d.notes.join(" ")).toMatch(/target budget/);
    const limited = evaluatePolicy(DEFAULT_POLICY, terms(110000), req(10, { preferredBudgetCents: 100000, budgetIsLimit: true }));
    expect(limited.decision).toBe("approval_required");
    expect(limited.reasons.map((r) => r.code)).toContain("BUYER_BUDGET_EXCEEDED");
    expect(limited.reasons.map((r) => r.code)).not.toContain("OVER_AUTO_LIMIT");
  });

  it("requires a manager when an order is above a strict budget, even below the automatic limit", () => {
    const decision = evaluatePolicy(DEFAULT_POLICY, terms(90001), req(10, { preferredBudgetCents: 90000, budgetIsLimit: true }));
    expect(decision.decision).toBe("approval_required");
    expect(decision.reasons.map((reason) => reason.code)).toContain("BUYER_BUDGET_EXCEEDED");
    expect(decision.reasons.map((reason) => reason.code)).not.toContain("OVER_AUTO_LIMIT");
  });

  it("auto-submits end-to-end exactly at the limit (100 packs × €12 = €1,200)", async () => {
    const seed = DEMO_SEED.map((s) => (s.sku === "A" ? { ...s, availablePacks: 100 } : s));
    const { service } = setup(seed);
    const out = await service.requestOrder(agent, { request: body(1000) });
    expect(out.outcome).toBe("submitted");
    expect(out.order!.currentRevision.terms.totalCents).toBe(120000);
  });
});

describe("order lifecycle", () => {
  it("fingerprint is stable and changes with any binding term", () => {
    const t = terms(1000);
    expect(fingerprintTerms(t)).toBe(fingerprintTerms(JSON.parse(JSON.stringify(t))));
    expect(fingerprintTerms({ ...t, lines: [{ ...t.lines[0], deliveryDate: "2026-11-15" }] })).not.toBe(fingerprintTerms(t));
    expect(fingerprintTerms({ ...t, lines: [{ ...t.lines[0], name: "renamed" }] })).toBe(fingerprintTerms(t)); // name is not a binding term
  });

  it("enforces roles at the service boundary", async () => {
    const { service } = setup();
    const out = await service.requestOrder(agent, { request: body(1000) });
    await expectServiceError(service.approve(agent, out.orderId!, { revision: 1, fingerprint: out.fingerprint! }), "FORBIDDEN_ROLE");
    await expectServiceError(service.approve(buyer, out.orderId!, { revision: 1, fingerprint: out.fingerprint! }), "FORBIDDEN_ROLE");
    await expectServiceError(service.requestOrder(approver, { request: body(10) }), "FORBIDDEN_ROLE");
  });

  it("cannot submit before approval", async () => {
    const { service } = setup();
    const out = await service.requestOrder(agent, { request: body(1000) });
    await expectServiceError(service.submit(agent, out.orderId!, { revision: 1, fingerprint: out.fingerprint! }), "NOT_APPROVED");
  });

  it("records rejection and blocks submission", async () => {
    const { service, provider } = setup();
    const out = await service.requestOrder(agent, { request: body(1000) });
    const r = await service.reject(approver, out.orderId!, { revision: 1, fingerprint: out.fingerprint!, reason: "Use existing stock" });
    expect(r.outcome).toBe("rejected");
    expect(r.order!.approvals[0]).toMatchObject({ decision: "rejected", actorName: approver.name, reason: "Use existing stock" });
    await expectServiceError(service.submit(approver, out.orderId!, { revision: 1, fingerprint: out.fingerprint! }), "NOT_APPROVED");
    expect(provider.listOrders()).toHaveLength(0);
  });

  it("price change between approval and submission blocks the stale revision and requires a fresh decision", async () => {
    const { service, provider } = setup();
    const out = await service.requestOrder(agent, { request: body(1000) });
    const fp1 = out.fingerprint!;
    await service.approve(approver, out.orderId!, { revision: 1, fingerprint: fp1 });
    provider.setPrice("B", 1475);
    const s = await service.submit(approver, out.orderId!, { revision: 1, fingerprint: fp1 });
    expect(s.outcome).toBe("requote_required");
    expect(s.revision).toBe(2);
    expect(s.order!.currentRevision.terms.totalCents).toBe(131000);
    expect(s.diff!.totalDeltaCents).toBe(7000);
    expect(s.diff!.changes.map((c) => c.field)).toEqual(["unit_price", "line_total", "total"]);
    // The approved snapshot is preserved.
    expect(s.order!.revisions[0].terms.totalCents).toBe(124000);
    expect(s.order!.approvals).toHaveLength(1);
    expect(provider.listOrders()).toHaveLength(0);
    // Submitting the replacement without a fresh approval is refused.
    await expectServiceError(service.submit(approver, out.orderId!, { revision: 2, fingerprint: s.fingerprint! }), "NOT_APPROVED");
  });

  it("stale approval from an older tab fails with the latest revision", async () => {
    const { service, provider } = setup();
    const out = await service.requestOrder(agent, { request: body(1000) });
    await service.approve(approver, out.orderId!, { revision: 1, fingerprint: out.fingerprint! });
    provider.setPrice("B", 1475);
    await service.submit(approver, out.orderId!, { revision: 1, fingerprint: out.fingerprint! });
    const err = await expectServiceError(service.approve(approver, out.orderId!, { revision: 1, fingerprint: out.fingerprint! }), "STALE_REVISION");
    expect(err.status).toBe(409);
    expect(err.extra.latestRevision).toBe(2);
    expect((err.extra.diff as any).totalDeltaCents).toBe(7000);
  });

  it("offer change while awaiting approval creates a new revision instead of recording the approval", async () => {
    const { service, provider } = setup();
    const out = await service.requestOrder(agent, { request: body(1000) });
    provider.setPrice("A", 1250);
    const a = await service.approve(approver, out.orderId!, { revision: 1, fingerprint: out.fingerprint! });
    expect(a.outcome).toBe("requote_required");
    expect(a.order!.approvals).toHaveLength(0);
    expect(a.order!.currentRevision.terms.totalCents).toBe(127000);
  });

  it("a stock change that still covers the order keeps the approval valid", async () => {
    const { service, provider } = setup();
    const out = await service.requestOrder(agent, { request: body(1000) });
    await service.approve(approver, out.orderId!, { revision: 1, fingerprint: out.fingerprint! });
    provider.setStock("A", 61);
    provider.setStock("B", 40);
    const s = await service.submit(approver, out.orderId!, { revision: 1, fingerprint: out.fingerprint! });
    expect(s.outcome).toBe("submitted");
    expect(s.revision).toBe(1);
  });

  it("a stock drop below the order re-optimises into a replacement that needs a new decision", async () => {
    const { service, provider } = setup();
    const out = await service.requestOrder(agent, { request: body(1000) });
    await service.approve(approver, out.orderId!, { revision: 1, fingerprint: out.fingerprint! });
    provider.setStock("B", 10);
    const s = await service.submit(approver, out.orderId!, { revision: 1, fingerprint: out.fingerprint! });
    expect(s.outcome).toBe("requote_required");
    expect(s.reasonCodes.map((r) => r.code)).toContain("STOCK_INSUFFICIENT");
    // A×60 + B×10 + C×30 = 720 + 130 + 420 = €1,270
    expect(s.order!.currentRevision.terms.lines.map((l) => `${l.sku}x${l.packs}`)).toEqual(["Ax60", "Bx10", "Cx30"]);
    expect(s.order!.currentRevision.terms.totalCents).toBe(127000);
    expect(provider.listOrders()).toHaveLength(0);
  });

  it("returns control to the buyer when no qualifying replacement exists", async () => {
    const { service, provider } = setup();
    const out = await service.requestOrder(agent, { request: body(1000) });
    await service.approve(approver, out.orderId!, { revision: 1, fingerprint: out.fingerprint! });
    provider.setStock("C", 0);
    provider.setStock("B", 0);
    const s = await service.submit(approver, out.orderId!, { revision: 1, fingerprint: out.fingerprint! });
    expect(s.outcome).toBe("no_eligible_offer");
    expect(s.status).toBe("returned_to_buyer");
    expect(s.nextAction).toBe("revise_request");
    expect(s.partialOptions!.length).toBeGreaterThan(0);
  });

  it("duplicate clicks and concurrent submissions create exactly one provider order", async () => {
    const { service, provider } = setup();
    const out = await service.requestOrder(agent, { request: body(1000) });
    await service.approve(approver, out.orderId!, { revision: 1, fingerprint: out.fingerprint! });
    const ref = { revision: 1, fingerprint: out.fingerprint! };
    const results = await Promise.all([service.submit(approver, out.orderId!, ref), service.submit(approver, out.orderId!, ref), service.submit(agent, out.orderId!, ref)]);
    const again = await service.submit(approver, out.orderId!, ref);
    expect(provider.listOrders()).toHaveLength(1);
    const id = provider.listOrders()[0].id;
    expect(again.providerOrderId).toBe(id);
    expect(results.filter((r) => r.outcome === "submitted")).toHaveLength(1);
    expect(results.every((r) => ["submitted", "submitting"].includes(r.outcome))).toBe(true);
  });

  it("provider idempotency: replaying the same submission key returns the same order", async () => {
    const { provider } = setup();
    const input = { submissionKey: "k1", lines: [{ sku: "A", packs: 1, expectedUnitPriceCents: 1200, expectedDeliveryDate: MONDAY }], expectedTotalCents: 1200, currency: "EUR" as const, requestedDeliveryDate: MONDAY };
    const a = await provider.submitOrder(input);
    const b = await provider.submitOrder(input);
    expect(a.providerOrderId).toBe(b.providerOrderId);
    expect(provider.listOffers().find((o) => o.sku === "A")!.availablePacks).toBe(59);
  });

  it("provider rejects stale terms atomically (conditional submission)", async () => {
    const { provider } = setup();
    provider.setPrice("A", 1300);
    await expect(
      provider.submitOrder({ submissionKey: "k2", lines: [{ sku: "A", packs: 1, expectedUnitPriceCents: 1200, expectedDeliveryDate: MONDAY }], expectedTotalCents: 1200, currency: "EUR", requestedDeliveryDate: MONDAY }),
    ).rejects.toThrow(/price/);
    expect(provider.listOrders()).toHaveLength(0);
    expect(provider.listOffers().find((o) => o.sku === "A")!.availablePacks).toBe(60);
  });

  it("timeout after commit → outcome unknown → reconcile finds the order (no duplicate)", async () => {
    const { service, provider } = setup();
    provider.setFault("timeout_after_commit");
    const out = await service.requestOrder(agent, { request: body(100) });
    expect(out.outcome).toBe("submission_outcome_unknown");
    expect(out.nextAction).toBe("reconcile");
    // A retry of the same revision is not sent blindly.
    const retry = await service.submit(agent, out.orderId!, { revision: 1, fingerprint: out.fingerprint! });
    expect(retry.outcome).toBe("submission_outcome_unknown");
    const r = await service.reconcile(agent, out.orderId!);
    expect(r.outcome).toBe("submitted");
    expect(provider.listOrders()).toHaveLength(1);
    expect(r.providerOrderId).toBe(provider.listOrders()[0].id);
  });

  it("timeout before commit → reconcile confirms nothing was created → safe resubmit", async () => {
    const { service, provider } = setup();
    provider.setFault("timeout_before_commit");
    const out = await service.requestOrder(agent, { request: body(100) });
    expect(out.outcome).toBe("submission_outcome_unknown");
    const r = await service.reconcile(agent, out.orderId!);
    expect(r.status).toBe("approved");
    const s = await service.submit(agent, out.orderId!, { revision: 1, fingerprint: out.fingerprint! });
    expect(s.outcome).toBe("submitted");
    expect(provider.listOrders()).toHaveLength(1);
  });

  it("clientRequestId makes request_order idempotent", async () => {
    const { service } = setup();
    const a = await service.requestOrder(agent, { request: body(1000), clientRequestId: "x-1" });
    const b = await service.requestOrder(agent, { request: body(1000), clientRequestId: "x-1" });
    expect(b.orderId).toBe(a.orderId);
  });

  it("validates agent-provided fields on the server", async () => {
    const { service } = setup();
    await expect(service.requestOrder(agent, { request: { ...body(1000), latestDeliveryDate: "2026-11-01" } })).rejects.toThrow(/past/);
    await expect(service.requestOrder(agent, { request: { ...body(1000), category: "beer" } })).rejects.toThrow();
    await expect(service.requestOrder(agent, { request: { ...body(1000), autoLimitCents: 999999 } })).rejects.toThrow();
  });
});
