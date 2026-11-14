import { nextCounter, type DB } from "./db.js";
import { compareOffers, evaluateEligibility, type Comparison } from "./domain/compare.js";
import { validateRequest } from "./domain/intake.js";
import { evaluatePolicy, type PolicyDecision, type PurchasingPolicy } from "./domain/policy.js";
import { diffTerms, fingerprintTerms, revalidateTerms, termsFromOption, type Revalidation, type TermsDiff } from "./domain/terms.js";
import type { Actor, Offer, OrderOption, OrderStatus, OrderTerms, Outcome, PurchaseRequest, ReasonCode, Role } from "./domain/types.js";
import { addDays, formatEur, helsinkiDate, sha256, type Clock } from "./domain/util.js";
import { OfferChangedError, ProviderNotSupportedError, ProviderTimeoutError, type Provider } from "./providers/provider.js";

export class ServiceError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const SYSTEM = {
  policy: { id: "system:policy", name: "Purchasing policy" },
  revalidation: { id: "system:revalidation", name: "Offer revalidation" },
  provider: { id: "system:provider", name: "Provider" },
};

export const DEFAULT_POLICY: PurchasingPolicy = {
  id: "kitchen-demo",
  name: "Central kitchen – demo policy",
  autoLimitCents: 120_000,
  currency: "EUR",
  substitution: "same_requirements",
};

export interface OutcomeResponse {
  outcome: Outcome;
  message: string;
  reasonCodes: ReasonCode[];
  nextAction: string | null;
  orderId?: string;
  status?: OrderStatus;
  revision?: number;
  fingerprint?: string;
  providerOrderId?: string | null;
  diff?: TermsDiff | null;
  comparison?: Comparison;
  partialOptions?: OrderOption[];
  order?: OrderView;
}

export interface RevisionView {
  revision: number;
  terms: OrderTerms;
  fingerprint: string;
  policy: PolicyDecision;
  changeReason: string | null;
  diff: TermsDiff | null;
  createdAt: string;
}

export interface OrderView {
  orderId: string;
  status: OrderStatus;
  outcome: Outcome;
  nextAction: string | null;
  statusReason: string | null;
  request: PurchaseRequest;
  optionKind: string;
  policy: PurchasingPolicy;
  provider: { id: string; label: string; orderMode?: "live" | "simulated" | "unavailable" };
  currentRevision: RevisionView;
  revisions: RevisionView[];
  approvals: Array<{ revision: number; fingerprint: string; decision: string; actorId: string; actorName: string; reason: string | null; at: string }>;
  submissions: Array<{ submissionKey: string; revision: number; status: string; providerOrderId: string | null; error: string | null; attempts: number }>;
  events: Array<{ id: number; at: string; actorId: string; actorName: string; action: string; reason: string | null; revision: number | null; data: unknown }>;
  providerOrderId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const OUTCOME_BY_STATUS: Record<OrderStatus, { outcome: Outcome; next: string | null }> = {
  proposed: { outcome: "approval_required", next: "await_policy" },
  awaiting_approval: { outcome: "approval_required", next: "human_approval" },
  approved: { outcome: "approved", next: "submit" },
  requote_required: { outcome: "requote_required", next: "human_approval_of_new_revision" },
  submitting: { outcome: "submitting", next: "poll_status" },
  submitted: { outcome: "submitted", next: null },
  submission_unknown: { outcome: "submission_outcome_unknown", next: "reconcile" },
  rejected: { outcome: "rejected", next: "revise_request" },
  returned_to_buyer: { outcome: "no_eligible_offer", next: "revise_request" },
};

function requireRole(actor: Actor, roles: Role[]): void {
  if (!roles.includes(actor.role))
    throw new ServiceError(403, "FORBIDDEN_ROLE", `${actor.name} (${actor.role}) may not perform this action; requires ${roles.join(" or ")}`);
}

export class OrderService {
  private catalogSnapshot: { checkedFor: string; expiresAt: number; products: Offer[] } | null = null;
  private catalogLoad: { checkedFor: string; promise: Promise<Offer[]> } | null = null;

  constructor(
    private db: DB,
    public provider: Provider,
    private clock: Clock,
  ) {
    this.db.prepare(`INSERT OR IGNORE INTO policies (id,name,auto_limit_cents,currency,substitution) VALUES (?,?,?,?,?)`).run(
      DEFAULT_POLICY.id,
      DEFAULT_POLICY.name,
      DEFAULT_POLICY.autoLimitCents,
      DEFAULT_POLICY.currency,
      DEFAULT_POLICY.substitution,
    );
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  getPolicy(id = DEFAULT_POLICY.id): PurchasingPolicy {
    const r = this.db.prepare("SELECT * FROM policies WHERE id=?").get(id) as any;
    return { id: r.id, name: r.name, autoLimitCents: r.auto_limit_cents, currency: r.currency, substitution: r.substitution };
  }

  /** Clears orders and history (used by the demo reset). */
  resetOrders(): void {
    this.db.transaction(() => {
      for (const t of ["order_events", "submissions", "approvals", "order_revisions", "orders"]) this.db.prepare(`DELETE FROM ${t}`).run();
      this.db.prepare("DELETE FROM policies").run();
      this.db.prepare(`INSERT INTO policies (id,name,auto_limit_cents,currency,substitution) VALUES (?,?,?,?,?)`).run(
        DEFAULT_POLICY.id, DEFAULT_POLICY.name, DEFAULT_POLICY.autoLimitCents, DEFAULT_POLICY.currency, DEFAULT_POLICY.substitution,
      );
    })();
  }

  private event(orderId: string, actor: { id: string; name: string }, action: string, reason: string | null, revision: number | null, data?: unknown) {
    this.db
      .prepare("INSERT INTO order_events (order_id, at, actor_id, actor_name, action, reason, revision, data_json) VALUES (?,?,?,?,?,?,?,?)")
      .run(orderId, this.now(), actor.id, actor.name, action, reason, revision, data === undefined ? null : JSON.stringify(data));
  }

  // ---------------- search & compare (agent operations) ----------------

  async searchProducts(input: unknown) {
    const req = validateRequest(input, this.clock.now());
    const offers = await this.provider.searchOffers(req);
    const { eligible, excluded } = evaluateEligibility(req, offers);
    return { request: req, provider: this.provider.info.id, offers: offers.filter((o) => !o.notQuoted), eligibleSkus: eligible.map((o) => o.sku), excluded };
  }

  async listCatalog() {
    const checkedFor = addDays(helsinkiDate(this.clock.now()), 7);
    let products: Offer[];
    if (this.catalogSnapshot?.checkedFor === checkedFor && this.catalogSnapshot.expiresAt > Date.now()) {
      products = this.catalogSnapshot.products;
    } else {
      const promise =
        this.catalogLoad?.checkedFor === checkedFor
          ? this.catalogLoad.promise
          : Promise.all(
              (["milk", "plant_milk"] as const).map((category) =>
                this.provider.searchOffers({
                  rawText: null,
                  category,
                  requiredAttributes: [],
                  quantity: 1,
                  unit: "L",
                  quantityMl: 1000,
                  latestDeliveryDate: checkedFor,
                  preferredBudgetCents: null,
                  budgetIsLimit: false,
                  requestedSku: null,
                }),
              ),
            ).then((offers) =>
              offers.flat().filter(
                (offer) =>
                  !offer.notQuoted &&
                  offer.priceCents != null &&
                  offer.availablePacks > 0 &&
                  !!offer.deliveryDate &&
                  offer.deliveryDate <= checkedFor &&
                  !offer.salesBlock,
              ),
            );
      if (this.catalogLoad?.checkedFor !== checkedFor) this.catalogLoad = { checkedFor, promise };
      try {
        products = await promise;
        this.catalogSnapshot = { checkedFor, expiresAt: Date.now() + 60_000, products };
      } finally {
        if (this.catalogLoad?.promise === promise) this.catalogLoad = null;
      }
    }
    return {
      provider: this.provider.info.id,
      checkedFor,
      products,
    };
  }

  async compare(input: unknown | PurchaseRequest): Promise<Comparison> {
    const req = validateRequest(stripDerived(input), this.clock.now());
    return compareOffers(req, await this.provider.searchOffers(req));
  }

  // ---------------- request_order ----------------

  async requestOrder(actor: Actor, body: { request: unknown; option?: "recommended" | "single" | "combined"; clientRequestId?: string }): Promise<OutcomeResponse> {
    requireRole(actor, ["agent", "buyer"]);
    if (body.clientRequestId) {
      const existing = this.db.prepare("SELECT id FROM orders WHERE client_request_id=?").get(body.clientRequestId) as { id: string } | undefined;
      if (existing) return this.outcomeFor(existing.id, "Duplicate request_order with the same clientRequestId; returning the existing order.");
    }
    const req = validateRequest(stripDerived(body.request), this.clock.now());
    const comparison = compareOffers(req, await this.provider.searchOffers(req));
    const choice = body.option ?? "recommended";
    const option = choice === "single" ? comparison.single : choice === "combined" ? comparison.combined : comparison.recommended;
    if (!option || !option.submittable) {
      const reason = comparison.noFill ?? { code: "OPTION_UNAVAILABLE", message: `No ${choice} option fulfils the request exactly` };
      return {
        outcome: "no_eligible_offer",
        message: reason.message,
        reasonCodes: [reason],
        nextAction: "revise_request",
        comparison,
        partialOptions: comparison.partialOptions,
      };
    }

    const policy = this.getPolicy();
    const terms = termsFromOption(option, req);
    const fingerprint = fingerprintTerms(terms);
    const decision = evaluatePolicy(policy, terms, req);
    const seq = nextCounter(this.db, "order");
    const orderId = `PO-${String(seq).padStart(4, "0")}`;
    const now = this.now();

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO orders (id,status,request_json,option_kind,policy_id,provider_id,current_revision,client_request_id,created_by,created_at,updated_at)
           VALUES (?,?,?,?,?,?,1,?,?,?,?)`,
        )
        .run(orderId, "proposed", JSON.stringify(req), option.kind, policy.id, this.provider.info.id, body.clientRequestId ?? null, actor.id, now, now);
      this.db
        .prepare("INSERT INTO order_revisions (order_id,revision,terms_json,fingerprint,policy_json,change_reason,diff_json,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(orderId, 1, JSON.stringify(terms), fingerprint, JSON.stringify(decision), null, null, now);
      this.event(orderId, actor, "proposal_created", `${option.kind === "combined" ? "Combined" : "Single-SKU"} order ${terms.lines.map((l) => `${l.sku}×${l.packs}`).join(" + ")} = ${formatEur(terms.totalCents)}`, 1, {
        fingerprint,
        savingsCents: comparison.savingsCents,
      });
      this.event(
        orderId,
        SYSTEM.policy,
        decision.decision === "auto_submit" ? "policy_auto_approved" : "policy_requires_approval",
        [...decision.reasons.map((r) => r.message), ...decision.notes].join("; "),
        1,
        decision,
      );
      if (decision.decision === "auto_submit") {
        this.db
          .prepare("INSERT INTO approvals (order_id,revision,fingerprint,decision,actor_id,actor_name,reason,at) VALUES (?,?,?,?,?,?,?,?)")
          .run(orderId, 1, fingerprint, "approved", SYSTEM.policy.id, SYSTEM.policy.name, `Within automatic limit ${formatEur(policy.autoLimitCents)}`, now);
        this.setStatus(orderId, "approved", null);
      } else {
        this.setStatus(orderId, "awaiting_approval", decision.reasons.map((r) => r.message).join("; "));
      }
    })();

    if (decision.decision === "auto_submit") {
      const res = await this.submit({ ...SYSTEM.policy, role: "agent" }, orderId, { revision: 1, fingerprint });
      return { ...res, comparison };
    }
    return { ...this.outcomeFor(orderId, `Approval required: ${decision.reasons.map((r) => r.message).join("; ")}`, decision.reasons), comparison };
  }

  private setStatus(orderId: string, status: OrderStatus, reason: string | null, extra: { providerOrderId?: string; revision?: number } = {}) {
    this.db
      .prepare(
        `UPDATE orders SET status=?, status_reason=?, updated_at=?, provider_order_id=COALESCE(?, provider_order_id), current_revision=COALESCE(?, current_revision) WHERE id=?`,
      )
      .run(status, reason, this.now(), extra.providerOrderId ?? null, extra.revision ?? null, orderId);
  }

  // ---------------- approval (human, approver role only) ----------------

  private assertCurrent(order: OrderRow, rev: RevisionRow, body: { revision: number; fingerprint: string }) {
    if (body.revision !== order.current_revision || body.fingerprint !== rev.fingerprint) {
      const seen = this.getRevision(order.id, body.revision);
      const diff = seen ? diffTerms(JSON.parse(seen.terms_json), JSON.parse(rev.terms_json)) : null;
      throw new ServiceError(
        409,
        "STALE_REVISION",
        `Revision ${body.revision} is no longer current. The latest is revision ${order.current_revision} (${formatEur(JSON.parse(rev.terms_json).totalCents)})${rev.change_reason ? `: ${rev.change_reason}` : ""}. Review it and decide again.`,
        { latestRevision: order.current_revision, latestFingerprint: rev.fingerprint, diff, order: this.getOrder(order.id) },
      );
    }
  }

  async approve(actor: Actor, orderId: string, body: { revision: number; fingerprint: string; reason?: string }): Promise<OutcomeResponse> {
    requireRole(actor, ["approver"]);
    let { order, rev } = this.load(orderId);
    if (order.created_by === actor.id) throw new ServiceError(403, "SEPARATION_OF_DUTIES", "The requester cannot approve their own order");
    const already = this.db.prepare("SELECT * FROM approvals WHERE order_id=? AND revision=? AND fingerprint=?").get(orderId, body.revision, body.fingerprint) as any;
    if (already && already.decision === "approved" && body.revision === order.current_revision)
      return this.outcomeFor(orderId, `Revision ${body.revision} was already approved by ${already.actor_name}.`);
    this.assertCurrent(order, rev, body);
    if (!["awaiting_approval", "requote_required"].includes(order.status))
      throw new ServiceError(409, "INVALID_STATE", `Order is ${order.status}; only orders awaiting approval can be approved`, { order: this.getOrder(orderId) });

    // The offer may have changed since it was shown to the approver: revalidate before recording the decision.
    const req: PurchaseRequest = JSON.parse(order.request_json);
    const terms: OrderTerms = JSON.parse(rev.terms_json);
    const fresh = await this.provider.quoteOffers(terms.lines.map((l) => l.sku), req.latestDeliveryDate);
    ({ order, rev } = this.load(orderId));
    this.assertCurrent(order, rev, body); // nothing changed during the async provider call
    const rv = revalidateTerms(terms, req, fresh);
    if (!rv.valid) return this.handleChange(order, rev, rv, "Offer changed before approval was recorded");

    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO approvals (order_id,revision,fingerprint,decision,actor_id,actor_name,reason,at) VALUES (?,?,?,?,?,?,?,?)")
        .run(orderId, rev.revision, rev.fingerprint, "approved", actor.id, actor.name, body.reason ?? null, this.now());
      this.setStatus(orderId, "approved", null);
      this.event(orderId, actor, "approved", body.reason || `Approved revision ${rev.revision} for ${formatEur(terms.totalCents)}`, rev.revision, { fingerprint: rev.fingerprint });
    })();
    return this.outcomeFor(orderId, `Revision ${rev.revision} approved for ${formatEur(terms.totalCents)}. Submit to place the order.`);
  }

  async reject(actor: Actor, orderId: string, body: { revision: number; fingerprint: string; reason?: string }): Promise<OutcomeResponse> {
    requireRole(actor, ["approver"]);
    const { order, rev } = this.load(orderId);
    this.assertCurrent(order, rev, body);
    if (!["awaiting_approval", "requote_required", "approved"].includes(order.status))
      throw new ServiceError(409, "INVALID_STATE", `Order is ${order.status} and cannot be rejected`);
    this.db.transaction(() => {
      this.db
        .prepare("INSERT OR REPLACE INTO approvals (order_id,revision,fingerprint,decision,actor_id,actor_name,reason,at) VALUES (?,?,?,?,?,?,?,?)")
        .run(orderId, rev.revision, rev.fingerprint, "rejected", actor.id, actor.name, body.reason ?? null, this.now());
      this.setStatus(orderId, "rejected", body.reason ?? "Rejected by approver");
      this.event(orderId, actor, "rejected", body.reason || "Rejected by approver", rev.revision);
    })();
    return this.outcomeFor(orderId, `Order rejected by ${actor.name}.`, [{ code: "REJECTED_BY_APPROVER", message: body.reason || "Rejected by approver" }]);
  }

  // ---------------- submission ----------------

  async submit(actor: Actor, orderId: string, body: { revision: number; fingerprint: string }): Promise<OutcomeResponse> {
    requireRole(actor, ["agent", "buyer", "approver"]);
    const submissionKey = sha256(`${orderId}:${body.revision}:${body.fingerprint}`).slice(0, 32);

    // Phase 1 (atomic): idempotency check, binding check, persist the submission record before calling the provider.
    const phase1 = this.db.transaction((): { proceed: false; res: OutcomeResponse } | { proceed: true } => {
      const { order, rev } = this.load(orderId);
      const sub = this.db.prepare("SELECT * FROM submissions WHERE submission_key=?").get(submissionKey) as any;
      if (sub?.status === "succeeded") return { proceed: false, res: this.outcomeFor(orderId, `Already submitted; provider order ${sub.provider_order_id}. Duplicate request ignored.`) };
      if (sub?.status === "pending") return { proceed: false, res: this.outcomeFor(orderId, "Submission already in progress for this revision; duplicate request ignored.") };
      if (sub?.status === "unknown") return { proceed: false, res: this.outcomeFor(orderId, "A previous submission outcome is unknown; reconcile before retrying.") };
      if (order.status === "submitted") return { proceed: false, res: this.outcomeFor(orderId, "Order is already submitted.") };
      this.assertCurrent(order, rev, body);
      if (order.status !== "approved")
        throw new ServiceError(409, "NOT_APPROVED", `Order is ${order.status}; revision ${rev.revision} needs an approval before submission`, { order: this.getOrder(orderId) });
      const appr = this.db
        .prepare("SELECT * FROM approvals WHERE order_id=? AND revision=? AND fingerprint=? AND decision='approved'")
        .get(orderId, rev.revision, rev.fingerprint);
      if (!appr) throw new ServiceError(409, "NOT_APPROVED", `No approval is bound to revision ${rev.revision} with this fingerprint`);
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO submissions (submission_key,order_id,revision,fingerprint,status,attempts,created_at,updated_at) VALUES (?,?,?,?, 'pending', 1, ?, ?)
           ON CONFLICT(submission_key) DO UPDATE SET status='pending', attempts=attempts+1, error=NULL, updated_at=excluded.updated_at`,
        )
        .run(submissionKey, orderId, rev.revision, rev.fingerprint, now, now);
      this.setStatus(orderId, "submitting", null);
      this.event(orderId, actor, "submission_started", `Revalidating revision ${rev.revision} with ${this.provider.info.label} before submission`, rev.revision, { submissionKey });
      return { proceed: true };
    });
    const p1 = phase1();
    if (!p1.proceed) return p1.res;

    const { order, rev } = this.load(orderId);
    const req: PurchaseRequest = JSON.parse(order.request_json);
    const terms: OrderTerms = JSON.parse(rev.terms_json);

    // Phase 2: revalidate against the provider immediately before submission.
    let rv: Revalidation;
    try {
      const fresh = await this.provider.quoteOffers(terms.lines.map((l) => l.sku), req.latestDeliveryDate);
      rv = revalidateTerms(terms, req, fresh);
    } catch (e: any) {
      return this.failSubmission(orderId, submissionKey, rev.revision, `Revalidation failed: ${e.message}`);
    }
    if (!rv.valid) {
      this.markSubmission(submissionKey, "aborted", null, rv.problems.map((p) => p.message).join("; "));
      return this.handleChange(order, rev, rv, "Offer changed after approval, before submission");
    }

    // Phase 3: conditional, idempotent order creation.
    try {
      const { providerOrderId } = await this.provider.submitOrder({
        submissionKey,
        lines: terms.lines.map((l) => ({ sku: l.sku, packs: l.packs, expectedUnitPriceCents: l.unitPriceCents, expectedDeliveryDate: l.deliveryDate })),
        expectedTotalCents: terms.totalCents,
        currency: terms.currency,
        requestedDeliveryDate: req.latestDeliveryDate,
      });
      this.db.transaction(() => {
        this.markSubmission(submissionKey, "succeeded", providerOrderId, null);
        this.setStatus(orderId, "submitted", null, { providerOrderId });
        const simulated = this.provider.info.orderMode === "simulated";
        this.event(
          orderId,
          SYSTEM.provider,
          "submitted",
          simulated ? `Demo order ${providerOrderId} recorded for ${formatEur(terms.totalCents)}; no supplier order was sent` : `Provider confirmed order ${providerOrderId} for ${formatEur(terms.totalCents)}`,
          rev.revision,
          { providerOrderId, submissionKey, simulated },
        );
      })();
      return this.outcomeFor(
        orderId,
        this.provider.info.orderMode === "simulated"
          ? `Demo order recorded. No order was sent to Valio. Demo reference ${providerOrderId}.`
          : `Order placed. Provider order ID ${providerOrderId}.`,
      );
    } catch (e: any) {
      if (e instanceof OfferChangedError) {
        this.markSubmission(submissionKey, "aborted", null, e.message);
        const fresh = await this.provider.quoteOffers(terms.lines.map((l) => l.sku), req.latestDeliveryDate);
        const rv2 = revalidateTerms(terms, req, fresh);
        if (rv2.valid) rv2.problems.push(...e.problems); // provider saw a change we could not reproduce; still require a new decision
        return this.handleChange(order, rev, rv2.valid ? { ...rv2, valid: false } : rv2, "Provider rejected the order because the offer changed");
      }
      if (e instanceof ProviderTimeoutError) {
        this.db.transaction(() => {
          this.markSubmission(submissionKey, "unknown", null, e.message);
          this.setStatus(orderId, "submission_unknown", e.message);
          this.event(orderId, SYSTEM.provider, "submission_outcome_unknown", `${e.message}. Not retried automatically; reconcile through the provider.`, rev.revision, { submissionKey });
        })();
        return this.outcomeFor(orderId, "Provider timed out; the order may or may not exist. Reconcile before retrying.", [{ code: "PROVIDER_TIMEOUT", message: e.message }]);
      }
      return this.failSubmission(orderId, submissionKey, rev.revision, e instanceof ProviderNotSupportedError ? e.message : `Provider error: ${e.message}`, e instanceof ProviderNotSupportedError ? "SUBMISSION_UNSUPPORTED" : "PROVIDER_ERROR");
    }
  }

  private markSubmission(key: string, status: string, providerOrderId: string | null, error: string | null) {
    this.db.prepare("UPDATE submissions SET status=?, provider_order_id=COALESCE(?, provider_order_id), error=?, updated_at=? WHERE submission_key=?").run(status, providerOrderId, error, this.now(), key);
  }

  private failSubmission(orderId: string, key: string, revision: number, message: string, code = "PROVIDER_ERROR"): OutcomeResponse {
    this.db.transaction(() => {
      this.markSubmission(key, "failed", null, message);
      this.setStatus(orderId, "approved", message);
      this.event(orderId, SYSTEM.provider, "submission_failed", message, revision);
    })();
    return { ...this.outcomeFor(orderId, message, [{ code, message }]), outcome: "submission_failed" };
  }

  async reconcile(actor: Actor, orderId: string): Promise<OutcomeResponse> {
    requireRole(actor, ["agent", "buyer", "approver"]);
    const { order, rev } = this.load(orderId);
    if (order.status !== "submission_unknown") return this.outcomeFor(orderId, `Nothing to reconcile; order is ${order.status}.`);
    const sub = this.db.prepare("SELECT * FROM submissions WHERE order_id=? AND status='unknown' ORDER BY updated_at DESC").get(orderId) as any;
    if (!this.provider.info.capabilities.orderLookup)
      return this.outcomeFor(orderId, "This provider cannot look up orders; confirm with the supplier manually.", [{ code: "RECONCILE_UNSUPPORTED", message: "Provider has no order lookup" }]);
    const found = await this.provider.findOrderBySubmissionKey(sub.submission_key);
    if (found) {
      this.db.transaction(() => {
        this.markSubmission(sub.submission_key, "succeeded", found.providerOrderId, null);
        this.setStatus(orderId, "submitted", null, { providerOrderId: found.providerOrderId });
        this.event(orderId, actor, "reconciled_submitted", `Provider has order ${found.providerOrderId} for submission key ${sub.submission_key.slice(0, 8)}…`, rev.revision, { providerOrderId: found.providerOrderId });
      })();
      return this.outcomeFor(orderId, `Reconciled: provider order ${found.providerOrderId} exists.`);
    }
    this.db.transaction(() => {
      this.markSubmission(sub.submission_key, "failed", null, "Provider has no order for this submission key");
      this.setStatus(orderId, "approved", "Previous attempt did not create an order; safe to submit again (same submission key)");
      this.event(orderId, actor, "reconciled_not_created", "Provider confirmed no order was created; the approved revision can be submitted again", rev.revision);
    })();
    return this.outcomeFor(orderId, "Reconciled: no order was created. The approved revision can be submitted again with the same submission key.");
  }

  // ---------------- offer change handling ----------------

  /**
   * Preserves the current (possibly approved) revision, and creates a replacement revision when a qualifying option
   * exists. A replacement always needs a fresh human decision. Without one, control returns to the buyer.
   */
  private async handleChange(order: OrderRow, rev: RevisionRow, rv: Revalidation, context: string): Promise<OutcomeResponse> {
    const req: PurchaseRequest = JSON.parse(order.request_json);
    const oldTerms: OrderTerms = JSON.parse(rev.terms_json);
    let replacement: OrderTerms | null = rv.requoted;
    let replacementNote = "same SKUs and pack counts at current provider terms";
    let comparison: Comparison | null = null;
    try {
      comparison = compareOffers(req, await this.provider.searchOffers(req));
    } catch {
      comparison = null;
    }
    if (!replacement && comparison?.recommended?.submittable) {
      replacement = termsFromOption(comparison.recommended, req);
      replacementNote = `re-optimised ${comparison.recommendedKind} order from the current catalog`;
    }
    const alternative =
      replacement && comparison?.recommended && comparison.recommended.totalCents < replacement.totalCents
        ? termsFromOption(comparison.recommended, req)
        : null;
    const problems = rv.problems;
    const problemText = problems.map((p) => p.message).join("; ");
    const policy = this.getPolicy();
    const current = this.load(order.id);
    if (current.order.current_revision !== rev.revision) return this.outcomeFor(order.id, "Order was already re-quoted by a concurrent request.");

    if (!replacement) {
      this.db.transaction(() => {
        this.setStatus(order.id, "returned_to_buyer", `${context}: ${problemText}. No qualifying replacement exists.`);
        this.event(order.id, SYSTEM.revalidation, "offer_changed", `${context}: ${problemText}`, rev.revision, { problems });
        this.event(order.id, SYSTEM.revalidation, "returned_to_buyer", comparison?.noFill?.message ?? "No qualifying replacement option; the buyer must revise the request", rev.revision);
      })();
      return {
        ...this.outcomeFor(order.id, `${context}. No qualifying replacement: ${comparison?.noFill?.message ?? "revise the request"}`, [...problems, ...(comparison?.noFill ? [comparison.noFill] : [])]),
        partialOptions: comparison?.partialOptions ?? [],
      };
    }

    const newRev = rev.revision + 1;
    const fingerprint = fingerprintTerms(replacement);
    const diff = diffTerms(oldTerms, replacement);
    const decision = evaluatePolicy(policy, replacement, req);
    const reason = `${context}: ${problemText}`;
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO order_revisions (order_id,revision,terms_json,fingerprint,policy_json,change_reason,diff_json,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(order.id, newRev, JSON.stringify(replacement), fingerprint, JSON.stringify(decision), reason, JSON.stringify(diff), this.now());
      this.setStatus(order.id, "requote_required", `${reason}. Revision ${newRev} needs a fresh human decision.`, { revision: newRev });
      this.event(order.id, SYSTEM.revalidation, "offer_changed", reason, rev.revision, { problems, previousFingerprint: rev.fingerprint });
      this.event(
        order.id,
        SYSTEM.revalidation,
        "replacement_proposed",
        `Revision ${newRev}: ${replacementNote}, ${formatEur(oldTerms.totalCents)} → ${formatEur(replacement!.totalCents)} (${diff.totalDeltaCents >= 0 ? "+" : ""}${formatEur(diff.totalDeltaCents)}). Previous approval is stale; fresh human decision required.`,
        newRev,
        { fingerprint, diff, alternative },
      );
    })();
    const reasons: ReasonCode[] = [...problems, { code: "FRESH_APPROVAL_REQUIRED", message: `Revision ${newRev} must be approved by a human before submission` }];
    if (alternative)
      reasons.push({
        code: "CHEAPER_ALTERNATIVE_AVAILABLE",
        message: `Re-optimising now would give ${alternative.lines.map((l) => `${l.sku}×${l.packs}`).join(" + ")} = ${formatEur(alternative.totalCents)}; revise the request to switch`,
      });
    return { ...this.outcomeFor(order.id, `${context}. Revision ${newRev} totals ${formatEur(replacement.totalCents)} (${diff.totalDeltaCents >= 0 ? "+" : ""}${formatEur(diff.totalDeltaCents)}).`, reasons), diff };
  }

  // ---------------- reads ----------------

  private load(orderId: string): { order: OrderRow; rev: RevisionRow } {
    const order = this.db.prepare("SELECT * FROM orders WHERE id=?").get(orderId) as OrderRow | undefined;
    if (!order) throw new ServiceError(404, "ORDER_NOT_FOUND", `Order ${orderId} not found`);
    const rev = this.getRevision(orderId, order.current_revision)!;
    return { order, rev };
  }

  private getRevision(orderId: string, revision: number): RevisionRow | undefined {
    return this.db.prepare("SELECT * FROM order_revisions WHERE order_id=? AND revision=?").get(orderId, revision) as RevisionRow | undefined;
  }

  outcomeFor(orderId: string, message: string, reasonCodes: ReasonCode[] = []): OutcomeResponse {
    const order = this.getOrder(orderId);
    const m = OUTCOME_BY_STATUS[order.status];
    const reasons = reasonCodes.length ? reasonCodes : order.currentRevision.policy.reasons;
    return {
      outcome: m.outcome,
      message,
      reasonCodes: reasons,
      nextAction: m.next,
      orderId,
      status: order.status,
      revision: order.currentRevision.revision,
      fingerprint: order.currentRevision.fingerprint,
      providerOrderId: order.providerOrderId,
      diff: order.currentRevision.diff,
      order,
    };
  }

  getOrder(orderId: string): OrderView {
    const order = this.db.prepare("SELECT * FROM orders WHERE id=?").get(orderId) as OrderRow | undefined;
    if (!order) throw new ServiceError(404, "ORDER_NOT_FOUND", `Order ${orderId} not found`);
    const revisions = (this.db.prepare("SELECT * FROM order_revisions WHERE order_id=? ORDER BY revision").all(orderId) as RevisionRow[]).map(toRevisionView);
    const m = OUTCOME_BY_STATUS[order.status];
    return {
      orderId,
      status: order.status,
      outcome: m.outcome,
      nextAction: m.next,
      statusReason: order.status_reason,
      request: JSON.parse(order.request_json),
      optionKind: order.option_kind,
      policy: this.getPolicy(order.policy_id),
      provider: { id: this.provider.info.id, label: this.provider.info.label, orderMode: this.provider.info.orderMode },
      currentRevision: revisions.find((r) => r.revision === order.current_revision)!,
      revisions,
      approvals: (this.db.prepare("SELECT * FROM approvals WHERE order_id=? ORDER BY id").all(orderId) as any[]).map((a) => ({
        revision: a.revision,
        fingerprint: a.fingerprint,
        decision: a.decision,
        actorId: a.actor_id,
        actorName: a.actor_name,
        reason: a.reason,
        at: a.at,
      })),
      submissions: (this.db.prepare("SELECT * FROM submissions WHERE order_id=? ORDER BY created_at").all(orderId) as any[]).map((s) => ({
        submissionKey: s.submission_key,
        revision: s.revision,
        status: s.status,
        providerOrderId: s.provider_order_id,
        error: s.error,
        attempts: s.attempts,
      })),
      events: (this.db.prepare("SELECT * FROM order_events WHERE order_id=? ORDER BY id").all(orderId) as any[]).map((e) => ({
        id: e.id,
        at: e.at,
        actorId: e.actor_id,
        actorName: e.actor_name,
        action: e.action,
        reason: e.reason,
        revision: e.revision,
        data: e.data_json ? JSON.parse(e.data_json) : null,
      })),
      providerOrderId: order.provider_order_id,
      createdBy: order.created_by,
      createdAt: order.created_at,
      updatedAt: order.updated_at,
    };
  }

  listOrders() {
    return (this.db.prepare("SELECT id FROM orders ORDER BY created_at DESC, id DESC").all() as { id: string }[]).map((r) => {
      const o = this.getOrder(r.id);
      return { orderId: o.orderId, status: o.status, totalCents: o.currentRevision.terms.totalCents, revision: o.currentRevision.revision, providerOrderId: o.providerOrderId, volumeMl: o.currentRevision.terms.volumeMl, createdAt: o.createdAt };
    });
  }
}

interface OrderRow {
  id: string;
  status: OrderStatus;
  request_json: string;
  option_kind: string;
  policy_id: string;
  provider_id: string;
  current_revision: number;
  provider_order_id: string | null;
  status_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}
interface RevisionRow {
  order_id: string;
  revision: number;
  terms_json: string;
  fingerprint: string;
  policy_json: string;
  change_reason: string | null;
  diff_json: string | null;
  created_at: string;
}

function toRevisionView(r: RevisionRow): RevisionView {
  return {
    revision: r.revision,
    terms: JSON.parse(r.terms_json),
    fingerprint: r.fingerprint,
    policy: JSON.parse(r.policy_json),
    changeReason: r.change_reason,
    diff: r.diff_json ? JSON.parse(r.diff_json) : null,
    createdAt: r.created_at,
  };
}

/** Accept a previously validated request object (which carries derived quantityMl) as input. */
function stripDerived(input: unknown): unknown {
  if (input && typeof input === "object" && "quantityMl" in (input as object)) {
    const { quantityMl: _q, ...rest } = input as Record<string, unknown>;
    return rest;
  }
  return input;
}

export type { Offer };
