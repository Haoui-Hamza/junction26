export type Role = "agent" | "buyer" | "approver";
export interface DemoActor { id: string; name: string; role: Role; token: string }

export interface ReasonCode { code: string; message: string }
export interface OptionLine { sku: string; name: string; packs: number; packVolumeMl: number; volumeMl: number; unitPriceCents: number; lineTotalCents: number; deliveryDate: string }
export interface OrderOption { kind: string; lines: OptionLine[]; totalCents: number; volumeMl: number; currency: string; latestDeliveryDate: string; qualifies: string[]; submittable: boolean }
export interface PurchaseRequest {
  rawText?: string | null; category: string; requiredAttributes: string[]; quantity: number; unit: "L";
  latestDeliveryDate: string; preferredBudgetCents: number | null; budgetIsLimit?: boolean; requestedSku: string | null; quantityMl?: number;
}
export interface Comparison {
  request: PurchaseRequest; single: OrderOption | null; combined: OrderOption | null; recommended: OrderOption | null;
  recommendedKind: "single" | "combined" | null; savingsCents: number | null;
  contributions: Array<{ sku: string; volumeMl: number; sharePct: number; lineTotalCents: number }>;
  notes: string[]; noFill: ReasonCode | null; partialOptions: OrderOption[]; searchBounded: boolean;
  excluded: Array<{ sku: string; name: string; reasons: ReasonCode[] }>;
  eligible: Array<{ sku: string; name: string; priceCents: number; packVolumeMl: number; availablePacks: number; stockKnown: boolean; deliveryDate: string }>;
}
export interface Terms { currency: string; lines: OptionLine[]; totalCents: number; volumeMl: number; latestDeliveryDate: string; deliveryDeadline: string }
export interface TermsDiff { changed: boolean; totalDeltaCents: number; changes: Array<{ field: string; sku?: string; old: unknown; new: unknown; message: string }> }
export interface RevisionView { revision: number; terms: Terms; fingerprint: string; policy: { decision: string; reasons: ReasonCode[]; notes: string[] }; changeReason: string | null; diff: TermsDiff | null; createdAt: string }
export interface OrderView {
  orderId: string; status: string; outcome: string; nextAction: string | null; statusReason: string | null; request: PurchaseRequest;
  policy: { autoLimitCents: number; name: string }; provider: { id: string; label: string; orderMode?: "live" | "simulated" | "unavailable" };
  currentRevision: RevisionView; revisions: RevisionView[];
  approvals: Array<{ revision: number; fingerprint: string; decision: string; actorName: string; reason: string | null; at: string }>;
  submissions: Array<{ submissionKey: string; revision: number; status: string; providerOrderId: string | null; error: string | null; attempts: number }>;
  events: Array<{ id: number; at: string; actorName: string; action: string; reason: string | null; revision: number | null }>;
  providerOrderId: string | null;
}
export interface Outcome {
  outcome: string; message: string; reasonCodes: ReasonCode[]; nextAction: string | null; orderId?: string; status?: string;
  revision?: number; fingerprint?: string; providerOrderId?: string | null; order?: OrderView; comparison?: Comparison; partialOptions?: OrderOption[];
}
export interface IntakeResult {
  source: "rules" | "llm"; draft: Partial<PurchaseRequest> & { rawText: string };
  interpretation: { deadlineText: string | null; resolvedDeadline: string | null; budgetText: string | null; today: string; timezone: string };
  missing: string[]; question: string | null; complete: boolean; notes: string[];
}
export interface AppConfigView {
  provider: { id: string; label: string; description: string; orderMode?: "live" | "simulated" | "unavailable"; capabilities: Record<string, boolean>; gaps: string[] };
  providerMode: string;
  clock: { now: string; today: string; todayLabel: string; fixed: boolean; timezone: string };
  policy: { id: string; name: string; autoLimitCents: number; currency: string; substitution: string };
  demoMode: boolean; llm: { enabled: boolean; model: string | null }; demoActors: DemoActor[];
}
export interface CatalogProduct {
  sku: string;
  name: string;
  category: string;
  attributes: { lactose_free?: boolean | null; organic?: boolean | null; vegan?: boolean | null };
  priceCents: number | null;
  packVolumeMl: number | null;
  availablePacks: number;
  stockKnown: boolean;
  deliveryDate: string | null;
}
export interface CatalogView { provider: string; checkedFor: string; products: CatalogProduct[] }

export class ApiError extends Error {
  constructor(public status: number, public body: any) {
    super(body?.error?.message ?? `HTTP ${status}`);
  }
}

export async function call<T>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !(res.status === 422 && data?.outcome)) throw new ApiError(res.status, data);
  return data as T;
}

export const eur = (cents: number | null | undefined) =>
  cents == null ? "—" : `${cents < 0 ? "−" : ""}€${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const signedEur = (cents: number) => `${cents > 0 ? "+" : cents < 0 ? "−" : "±"}€${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
export const litres = (ml: number) => `${(ml / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 })} L`;
export const longDate = (iso: string | null | undefined) =>
  iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—";
export const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Europe/Helsinki", hour: "2-digit", minute: "2-digit", second: "2-digit" });
