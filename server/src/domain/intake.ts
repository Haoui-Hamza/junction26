import { z } from "zod";
import { SUPPORTED_ATTRIBUTES, type Attribute, type PurchaseRequest } from "./types.js";
import { addDays, describeDate, helsinkiDate, weekday } from "./util.js";

export const SUPPORTED_CATEGORIES = ["milk", "plant_milk"] as const;

/** Server-side schema for any structured request, whether typed in a form, produced by an LLM or sent by an agent. */
export const PurchaseRequestInput = z
  .object({
    rawText: z.string().max(2000).nullish(),
    category: z.enum(SUPPORTED_CATEGORIES),
    requiredAttributes: z.array(z.enum(SUPPORTED_ATTRIBUTES)).max(5).default([]),
    quantity: z.number().positive().max(1_000_000),
    unit: z.literal("L"),
    latestDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
    preferredBudgetCents: z.number().int().positive().nullish(),
    budgetIsLimit: z.boolean().default(false),
    requestedSku: z.string().min(1).max(64).nullish(),
  })
  .strict();

export type PurchaseRequestInputT = z.input<typeof PurchaseRequestInput>;

export class ValidationError extends Error {
  constructor(public issues: Array<{ field: string; message: string }>) {
    super(issues.map((i) => `${i.field}: ${i.message}`).join("; "));
  }
}

export function validateRequest(input: unknown, now: Date): PurchaseRequest {
  const parsed = PurchaseRequestInput.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ field: i.path.join(".") || "request", message: i.message })));
  const r = parsed.data;
  const issues: Array<{ field: string; message: string }> = [];
  const quantityMl = Math.round(r.quantity * 1000);
  if (Math.abs(quantityMl - r.quantity * 1000) > 1e-6) issues.push({ field: "quantity", message: "Quantity must be a whole number of millilitres" });
  const today = helsinkiDate(now);
  if (Number.isNaN(new Date(`${r.latestDeliveryDate}T00:00:00Z`).getTime())) issues.push({ field: "latestDeliveryDate", message: "Not a valid date" });
  else if (r.latestDeliveryDate < today) issues.push({ field: "latestDeliveryDate", message: `Deadline ${r.latestDeliveryDate} is in the past (today is ${today} in Europe/Helsinki)` });
  if (issues.length) throw new ValidationError(issues);
  return {
    rawText: r.rawText ?? null,
    category: r.category,
    requiredAttributes: [...new Set(r.requiredAttributes)].sort() as Attribute[],
    quantity: r.quantity,
    unit: "L",
    quantityMl,
    latestDeliveryDate: r.latestDeliveryDate,
    preferredBudgetCents: r.preferredBudgetCents ?? null,
    budgetIsLimit: r.budgetIsLimit,
    requestedSku: r.requestedSku ?? null,
  };
}

// ---------------- natural-language intake ----------------

export interface IntakeResult {
  source: "rules" | "llm";
  draft: Partial<Omit<PurchaseRequest, "quantityMl">> & { rawText: string };
  interpretation: { deadlineText: string | null; resolvedDeadline: string | null; budgetText: string | null; today: string; timezone: string };
  missing: string[];
  question: string | null; // ONE targeted question when something required is missing or ambiguous
  complete: boolean;
  notes: string[];
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sunnuntai: 0, maanantai: 1, tiistai: 2, keskiviikko: 3, torstai: 4, perjantai: 5, lauantai: 6,
};

function parseNumber(s: string): number {
  const t = s.trim().replace(/ /g, " ");
  if (/^\d{1,3}([ ,.]\d{3})+$/.test(t)) return Number(t.replace(/[ ,.]/g, ""));
  return Number(t.replace(/\s/g, "").replace(",", "."));
}

export interface DeadlineResolution {
  date: string | null;
  text: string | null;
  ambiguity: string | null;
}

export function resolveDeadline(text: string, now: Date): DeadlineResolution {
  const today = helsinkiDate(now);
  const lower = text.toLowerCase();
  if (/\bbefore next week\b|\bbefore the next week\b|\bprior to next week\b/.test(lower))
    return {
      date: null,
      text: text.match(/\b(?:before next week|before the next week|prior to next week)\b/i)?.[0] ?? null,
      ambiguity: '“Before next week” is not a specific delivery date. What is the latest date your kitchen can accept?',
    };
  const iso = lower.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return { date: iso[1], text: iso[1], ambiguity: null };
  const fi = lower.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})?/);
  if (fi) {
    const year = fi[3] ? Number(fi[3]) : Number(today.slice(0, 4));
    let date = `${year}-${fi[2].padStart(2, "0")}-${fi[1].padStart(2, "0")}`;
    if (!fi[3] && date < today) date = `${year + 1}-${fi[2].padStart(2, "0")}-${fi[1].padStart(2, "0")}`;
    return { date, text: fi[0], ambiguity: null };
  }
  if (/\btomorrow\b|\bhuomenna\b/.test(lower)) return { date: addDays(today, 1), text: "tomorrow", ambiguity: null };
  if (/\btoday\b|\btänään\b/.test(lower)) return { date: today, text: "today", ambiguity: null };
  const beforeWeekday = lower.match(/\bbefore\s+(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sunnuntai|maanantai|tiistai|keskiviikko|torstai|perjantai|lauantai)\b/);
  if (beforeWeekday) {
    const target = WEEKDAYS[beforeWeekday[2]];
    const cur = weekday(today);
    let delta = (target - cur + 7) % 7;
    if (delta === 0 && beforeWeekday[1]) delta = 7;
    if (delta === 0)
      return {
        date: null,
        text: beforeWeekday[0],
        ambiguity: `"${beforeWeekday[0]}" is already in progress or past. What is the latest date your kitchen can accept?`,
      };
    return { date: addDays(today, delta - 1), text: beforeWeekday[0], ambiguity: null };
  }
  const wd = lower.match(/\b(next\s+|ensi\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sunnuntai|maanantai|tiistai|keskiviikko|torstai|perjantai|lauantai)(?:hin|na)?\b/);
  if (wd) {
    const target = WEEKDAYS[wd[2]];
    const cur = weekday(today);
    let delta = (target - cur + 7) % 7;
    if (delta === 0) {
      if (!wd[1])
        return {
          date: null,
          text: wd[0],
          ambiguity: `"${wd[0].trim()}" could mean today (${describeDate(today)}) or next week (${describeDate(addDays(today, 7))}). Which date is the latest acceptable delivery?`,
        };
      delta = 7;
    }
    return { date: addDays(today, delta), text: wd[0].trim(), ambiguity: null };
  }
  return { date: null, text: null, ambiguity: null };
}

/** Deterministic rule-based parser; always available, used when no LLM is configured. */
export function parseRequestRules(text: string, now: Date): IntakeResult {
  const lower = text.toLowerCase();
  const notes: string[] = [];
  const draft: IntakeResult["draft"] = { rawText: text, unit: "L", requiredAttributes: [], preferredBudgetCents: null, requestedSku: null };
  let unitAmbiguity: string | null = null;

  if (/\b(?:vegan|plant[- ]based|oat|soy|soya|almond)\s+(?:milk|drink)\b|\b(?:oat|soy|soya|almond)\s+milk\b/i.test(lower))
    draft.category = "plant_milk";
  else if (/\bmilk\b|maito/.test(lower)) draft.category = "milk";
  const attrs: Attribute[] = [];
  if (/lactose[- ]?free|laktoositon/.test(lower)) attrs.push("lactose_free");
  if (/\borganic\b|luomu/.test(lower)) attrs.push("organic");
  if (/\bvegan\b|plant[- ]based/.test(lower)) attrs.push("vegan");
  draft.requiredAttributes = attrs;

  const qty = text.match(/(\d{1,3}(?:[ ,. ]\d{3})+|\d+(?:[.,]\d+)?)\s*(litres?|liters?|ltr|l|dl|ml|litraa?)\b/i);
  if (qty) {
    const n = parseNumber(qty[1]);
    const u = qty[2].toLowerCase();
    const litres = u === "dl" ? n / 10 : u === "ml" ? n / 1000 : n;
    draft.quantity = litres;
    if (u === "dl" || u === "ml") notes.push(`Converted ${qty[0]} to ${litres} L`);
  } else {
    const bare = text.match(/\b(?:get|order|need|buy|tilaa)\s+(\d[\d ,.]*)\s+(?!litres?|l\b)([a-zåäö-]+)/i);
    if (bare) unitAmbiguity = `You asked for ${bare[1].trim()} ${bare[2]} — how many litres is that?`;
  }

  let budgetText: string | null = null;
  const budget = text.match(/(?:under|below|less than|max(?:imum)?|within|up to|at most|budget(?:\s+(?:limit|maximum))?(?:\s+is|[:=]|\s+of)?|limit(?:\s+of)?|alle)\s*(€|eur\s*)?\s*(\d[\d ,.]*\d|\d)\s*(€|eur(?:os)?)?/i);
  if (budget) {
    draft.preferredBudgetCents = Math.round(parseNumber(budget[2]) * 100);
    draft.budgetIsLimit =
      /\b(?:under|below|less than|max(?:imum)?|within|up to|at most|budget\s+(?:limit|maximum)|budget(?:\s+(?:limit|maximum))?\s+(?:is|of)|maximum budget|limit(?:\s+of)?|not exceed|do not exceed|must not exceed)\b/i.test(budget[0]) &&
      !/\b(?:if possible|preferably|ideally|jos mahdollista)\b/i.test(text);
    budgetText = budget[0].trim();
    if (!draft.budgetIsLimit && /if possible|preferably|ideally|jos mahdollista/i.test(text)) notes.push("Budget is a target, not a strict limit.");
  }
  const sku = text.match(/\bSKU[:\s#]*([A-Za-z0-9-]+)/i);
  if (sku) draft.requestedSku = sku[1].toUpperCase();

  const dl = resolveDeadline(text, now);
  if (dl.date) draft.latestDeliveryDate = dl.date;

  return finalizeIntake("rules", draft, dl, budgetText, unitAmbiguity, notes, now);
}

function finalizeIntake(
  source: IntakeResult["source"],
  draft: IntakeResult["draft"],
  dl: DeadlineResolution,
  budgetText: string | null,
  unitAmbiguity: string | null,
  notes: string[],
  now: Date,
): IntakeResult {
  const missing: string[] = [];
  let question: string | null = null;
  if (!draft.category) {
    missing.push("category");
    question ??= "Which product do you need? (Supported in this demo: dairy milk or plant-based milk.)";
  }
  if (!draft.quantity) {
    missing.push("quantity");
    question ??= unitAmbiguity ?? "How many litres do you need?";
  }
  if (!draft.latestDeliveryDate) {
    missing.push("latestDeliveryDate");
    question ??= dl.ambiguity ?? "By which date must the delivery arrive at the latest?";
  } else if (draft.latestDeliveryDate < helsinkiDate(now)) {
    missing.push("latestDeliveryDate");
    question ??= `The deadline ${describeDate(draft.latestDeliveryDate)} is in the past. Which date did you mean?`;
  }
  return {
    source,
    draft,
    interpretation: { deadlineText: dl.text, resolvedDeadline: draft.latestDeliveryDate ?? null, budgetText, today: helsinkiDate(now), timezone: "Europe/Helsinki" },
    missing,
    question,
    complete: missing.length === 0,
    notes,
  };
}

// ---------------- optional OpenAI intake ----------------

const LlmExtraction = z.object({
  category: z.string().nullable().describe("Product category: 'milk' for dairy or 'plant_milk' for plant-based milk"),
  requiredAttributes: z.array(z.string()).describe("Hard product requirements, e.g. 'lactose_free', 'organic', 'vegan'"),
  quantity: z.number().nullable(),
  unit: z.string().nullable().describe("Unit of the stated quantity: L, dl or ml"),
  deadlineText: z.string().nullable().describe("The deadline phrase exactly as written, e.g. 'by Monday'"),
  deadlineDate: z.string().nullable().describe("Resolved latest delivery date as YYYY-MM-DD"),
  preferredBudgetEur: z.number().nullable(),
  budgetIsLimit: z.boolean(),
  requestedSku: z.string().nullable(),
  ambiguity: z.string().nullable().describe("One short question if a required detail is missing or ambiguous, else null"),
});

export async function parseRequestLlm(text: string, now: Date, apiKey: string, model: string): Promise<IntakeResult> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey, timeout: 30_000, maxRetries: 1 });
  const today = helsinkiDate(now);
  const response = await client.chat.completions.create({
    model,
    max_tokens: 1000,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "kitchen_purchase_request",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["category", "requiredAttributes", "quantity", "unit", "deadlineText", "deadlineDate", "preferredBudgetEur", "budgetIsLimit", "requestedSku", "ambiguity"],
          properties: {
            category: { type: ["string", "null"], description: "Product category: milk for dairy or plant_milk for plant-based milk" },
            requiredAttributes: { type: "array", items: { type: "string" }, description: "Hard requirements such as lactose_free, organic or vegan" },
            quantity: { type: ["number", "null"] },
            unit: { type: ["string", "null"], description: "Quantity unit: L, dl or ml" },
            deadlineText: { type: ["string", "null"], description: "Deadline phrase from the request" },
            deadlineDate: { type: ["string", "null"], description: "Resolved deadline in YYYY-MM-DD" },
            preferredBudgetEur: { type: ["number", "null"], description: "Soft budget preference in euros" },
            budgetIsLimit: { type: "boolean", description: "True only when the buyer says the budget must not be exceeded; false for targets such as 'if possible' or 'preferably'" },
            requestedSku: { type: ["string", "null"] },
            ambiguity: { type: ["string", "null"], description: "One focused question if a required detail is unclear" },
          },
        },
      },
    },
    messages: [
      {
        role: "system",
        content:
          "Convert the buyer's request into structured purchasing fields. " +
          `Today is ${describeDate(today)} (${today}) in Europe/Helsinki; resolve relative dates against this date. ` +
          "Map lactose-free to lactose_free, organic to organic, and vegan/plant-based milk to category plant_milk with required attribute vegan. " +
          "Set budgetIsLimit true for an explicit budget limit/maximum that must not be exceeded; set it false for a target phrased as 'if possible', 'preferably', or 'ideally'. " +
          "Never invent values; use null when missing.",
      },
      { role: "user", content: text },
    ],
  });
  const content = response.choices[0]?.message.content;
  if (!content || response.choices[0]?.message.refusal) throw new Error("OpenAI returned no structured request output");
  const out = LlmExtraction.parse(JSON.parse(content));

  // Server-side validation of agent-generated fields: only accept known categories/attributes and sane values.
  const notes: string[] = [];
  const draft: IntakeResult["draft"] = { rawText: text, unit: "L", requiredAttributes: [], preferredBudgetCents: null, requestedSku: null };
  if (out.category && (SUPPORTED_CATEGORIES as readonly string[]).includes(out.category.toLowerCase())) draft.category = out.category.toLowerCase();
  else if (out.category) notes.push(`Category "${out.category}" is not supported in this demo`);
  draft.requiredAttributes = out.requiredAttributes.filter((a): a is Attribute => (SUPPORTED_ATTRIBUTES as readonly string[]).includes(a));
  const dropped = out.requiredAttributes.filter((a) => !(SUPPORTED_ATTRIBUTES as readonly string[]).includes(a));
  if (dropped.length) notes.push(`Ignored unsupported attributes: ${dropped.join(", ")}`);
  draft.budgetIsLimit = out.budgetIsLimit;
  if (out.quantity && out.quantity > 0) {
    const u = (out.unit ?? "L").toLowerCase();
    draft.quantity = u === "dl" ? out.quantity / 10 : u === "ml" ? out.quantity / 1000 : out.quantity;
  }
  if (out.preferredBudgetEur && out.preferredBudgetEur > 0) draft.preferredBudgetCents = Math.round(out.preferredBudgetEur * 100);
  if (out.requestedSku) draft.requestedSku = out.requestedSku;
  const rulesIntake = parseRequestRules(text, now);
  if (rulesIntake.draft.category) draft.category = rulesIntake.draft.category;
  for (const attr of rulesIntake.draft.requiredAttributes ?? []) {
    if (!draft.requiredAttributes.includes(attr)) draft.requiredAttributes.push(attr);
  }
  if (rulesIntake.draft.preferredBudgetCents != null) {
    draft.preferredBudgetCents = rulesIntake.draft.preferredBudgetCents;
    draft.budgetIsLimit = !!rulesIntake.draft.budgetIsLimit;
  }
  // Cross-check the date against the deterministic resolver; prefer the deterministic answer when they differ.
  const rules = resolveDeadline(text, now);
  let dl: DeadlineResolution = { date: null, text: out.deadlineText, ambiguity: out.ambiguity };
  if (rules.date || rules.ambiguity) {
    if (out.deadlineDate && rules.date && out.deadlineDate !== rules.date) notes.push(`LLM resolved ${out.deadlineDate}; deterministic resolver says ${rules.date} (used)`);
    dl = rules;
  } else if (out.deadlineDate && /^\d{4}-\d{2}-\d{2}$/.test(out.deadlineDate)) dl = { date: out.deadlineDate, text: out.deadlineText, ambiguity: null };
  if (dl.date) draft.latestDeliveryDate = dl.date;
  return finalizeIntake("llm", draft, dl, draft.preferredBudgetCents ? `€${out.preferredBudgetEur}` : null, out.ambiguity, notes, now);
}
