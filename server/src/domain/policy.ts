import type { OrderTerms, PurchaseRequest, ReasonCode } from "./types.js";
import { formatEur } from "./util.js";

/** Kitchen purchasing policy. Comes from the service (DB), never from what the buyer types. */
export interface PurchasingPolicy {
  id: string;
  name: string;
  autoLimitCents: number;
  currency: "EUR";
  /** "same_requirements": any SKU meeting the same requirements may be used, including multi-SKU fills. */
  substitution: "same_requirements" | "exact_sku_only";
}

export interface PolicyDecision {
  decision: "auto_submit" | "approval_required";
  reasons: ReasonCode[];
  notes: string[];
}

export function evaluatePolicy(policy: PurchasingPolicy, terms: OrderTerms, req: PurchaseRequest): PolicyDecision {
  const reasons: ReasonCode[] = [];
  const notes: string[] = [];
  if (terms.currency !== policy.currency) reasons.push({ code: "CURRENCY_MISMATCH", message: `Order currency ${terms.currency} differs from policy currency ${policy.currency}` });
  if (terms.totalCents > policy.autoLimitCents)
    reasons.push({
      code: "OVER_AUTO_LIMIT",
      message: `Total ${formatEur(terms.totalCents)} exceeds the automatic spending limit of ${formatEur(policy.autoLimitCents)} by ${formatEur(terms.totalCents - policy.autoLimitCents)}`,
    });
  if (req.budgetIsLimit && req.preferredBudgetCents != null && terms.totalCents > req.preferredBudgetCents)
    reasons.push({
    code: "BUYER_BUDGET_EXCEEDED",
    message: `Total ${formatEur(terms.totalCents)} is above the buyer's budget limit of ${formatEur(req.preferredBudgetCents)} by ${formatEur(terms.totalCents - req.preferredBudgetCents)}. Manager approval is required to proceed.`,
    });
  if (req.requestedSku && terms.lines.some((l) => l.sku !== req.requestedSku))
    reasons.push({ code: "SUBSTITUTION_NOT_ALLOWED", message: `Buyer requested SKU ${req.requestedSku}; another SKU would be a substitution` });
  if (policy.substitution === "exact_sku_only" && !req.requestedSku)
    reasons.push({ code: "SUBSTITUTION_POLICY", message: "Policy only allows explicitly named SKUs to be ordered automatically" });
  if (req.preferredBudgetCents != null && terms.totalCents > req.preferredBudgetCents)
    notes.push(
      req.budgetIsLimit
        ? `This option is ${formatEur(terms.totalCents - req.preferredBudgetCents)} above the buyer's budget limit of ${formatEur(req.preferredBudgetCents)}.`
        : `Total ${formatEur(terms.totalCents)} is above the buyer's target budget of ${formatEur(req.preferredBudgetCents)}.`,
    );
  if (!reasons.length) notes.push(`Total ${formatEur(terms.totalCents)} is within the automatic spending limit of ${formatEur(policy.autoLimitCents)}`);
  return { decision: reasons.length ? "approval_required" : "auto_submit", reasons, notes };
}
