import OpenAI from "openai";
import { z } from "zod";
import { nextCounter, type DB } from "./db.js";
import type { Actor } from "./domain/types.js";
import { canonicalJson, formatEur, helsinkiDate, sha256, type Clock } from "./domain/util.js";
import { ServiceError } from "./orders.js";
import { ValioProvider } from "./providers/valio.js";

const lineSchema = z.object({
  ingredient: z.string().trim().min(1).max(100),
  sku: z.string().min(1).max(64),
  packs: z.number().int().min(1).max(100000),
  requiredGrams: z.number().int().positive().max(100_000_000).optional(),
});
export const basketInputSchema = z.object({
  description: z.string().trim().min(1).max(2000),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dietaryNotes: z.string().max(500),
  budgetCents: z.number().int().positive().nullable(),
  budgetIsLimit: z.boolean(),
  lines: z.array(lineSchema).min(1).max(30),
}).strict();
export type BasketInput = z.infer<typeof basketInputSchema>;

export async function classifyRequest(text: string, apiKey?: string, model = "gpt-4o-mini"): Promise<"milk" | "basket"> {
  if (!apiKey) return /\b(?:milk|maito)\b/i.test(text) && /\b(?:litres?|liters?|ltr|dl|ml|l)\b/i.test(text) && !/\b(?:recipe|meal|pasta|bolognese|spaghetti|ingredients)\b/i.test(text) ? "milk" : "basket";
  const client = new OpenAI({ apiKey, timeout: 20000, maxRetries: 0 });
  const result = await client.chat.completions.create({
    model, max_tokens: 30,
    response_format: { type: "json_schema", json_schema: {
      name: "request_kind", strict: true,
      schema: { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { type: "string", enum: ["milk", "basket"] } } },
    } },
    messages: [
      { role: "system", content: "Classify the request as milk ONLY if it is an order for a single type of dairy or plant milk measured in litres. All meals, recipes, ingredient lists, other products and unclear requests are basket. Never classify a meal with milk as milk." },
      { role: "user", content: text },
    ],
  });
  const content = result.choices[0]?.message.content;
  if (!content || result.choices[0]?.message.refusal) throw new Error("Could not understand the request type. Please try again.");
  return z.object({ kind: z.enum(["milk", "basket"]) }).parse(JSON.parse(content)).kind;
}

export async function suggestIngredients(text: string, servings: number, apiKey: string, model: string) {
  const client = new OpenAI({ apiKey, timeout: 30000, maxRetries: 0 });
  const result = await client.chat.completions.create({
    model,
    max_tokens: 1200,
    response_format: { type: "json_schema", json_schema: {
      name: "ingredients", strict: true,
      schema: { type: "object", additionalProperties: false, required: ["ingredients", "explanation"], properties: {
        ingredients: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "grams"], properties: { name: { type: "string" }, grams: { type: "number" } } }, maxItems: 12 },
        explanation: { type: "string" },
      } },
    } },
    messages: [
      { role: "system", content: "Suggest only essential grocery ingredients for the meal, with a reasonable estimated total weight in grams for the specified number of servings. Quantities are estimates for the buyer to review, not precise dietary advice. Use short, specific English catalog search names such as 'spaghetti', 'minced beef' and 'crushed tomatoes' rather than vague or uncommon variants such as 'canned tomatoes'. Do not infer dietary restrictions or product availability. If the meal is unclear, return an empty list and ask what to prepare. Do not claim dietary or allergen safety." },
      { role: "user", content: JSON.stringify({ request: text, servings }) },
    ],
  });
  const content = result.choices[0]?.message.content;
  if (!content || result.choices[0]?.message.refusal) throw new Error("Could not suggest ingredients for this request.");
  return z.object({ ingredients: z.array(z.object({ name: z.string().trim().min(1).max(100), grams: z.number().positive().max(100_000_000) })).max(12), explanation: z.string().max(1000) }).parse(JSON.parse(content));
}

export const recommendationSchema = z.object({
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dietaryNotes: z.string().max(500),
  ingredients: z.array(z.object({ name: z.string().trim().min(1).max(100), grams: z.number().int().positive().max(100_000_000) })).min(1).max(12),
}).strict();

function compatibleMeatName(ingredient: string, product: string): boolean {
  const meats = ["beef", "pork", "chicken", "turkey", "lamb", "fish"];
  const mentioned = meats.filter((meat) => new RegExp(`\\b${meat}\\b`, "i").test(ingredient));
  if (!mentioned.length) return true;
  return meats.every((meat) => mentioned.includes(meat) || !new RegExp(`\\b${meat}\\b`, "i").test(product));
}

export async function recommendIngredients(service: BasketService, input: z.infer<typeof recommendationSchema>, apiKey: string, model: string) {
  const findCandidates = async (ingredient: z.infer<typeof recommendationSchema>["ingredients"][number]) => {
    const eligible = (products: Awaited<ReturnType<BasketService["search"]>>) => products.flatMap((p) => {
      if (!p.packWeightG || p.priceCents == null || !compatibleMeatName(ingredient.name, p.name)) return [];
      const packs = Math.ceil(ingredient.grams / p.packWeightG);
      if (packs > 100000 || packs > p.availablePacks) return [];
      return [{ ...p, packs, totalCents: packs * p.priceCents }];
    });
    let candidates = eligible(await service.search(ingredient.name, input.deliveryDate));
    if (!candidates.length) {
      const words = ingredient.name.toLowerCase().match(/[a-zåäö0-9]+/g) ?? [];
      const last = words.at(-1);
      const broader = last?.endsWith("toes") ? last.slice(0, -2) : last;
      if (broader && broader !== ingredient.name.toLowerCase()) {
        candidates = eligible(await service.search(broader, input.deliveryDate));
      }
    }
    candidates.sort((a, b) => a.totalCents - b.totalCents || a.sku.localeCompare(b.sku));
    candidates = candidates.slice(0, 30);
    return { ingredient, candidates };
  };
  const groups: Awaited<ReturnType<typeof findCandidates>>[] = [];
  for (let i = 0; i < input.ingredients.length; i += 3) {
    groups.push(...await Promise.all(input.ingredients.slice(i, i + 3).map(findCandidates)));
  }
  const client = new OpenAI({ apiKey, timeout: 30000, maxRetries: 0 });
  const result = await client.chat.completions.create({
    model, max_tokens: 1200,
    response_format: { type: "json_schema", json_schema: {
      name: "ingredient_matches", strict: true, schema: { type: "object", additionalProperties: false, required: ["matches"], properties: {
        matches: { type: "array", items: { type: "object", additionalProperties: false, required: ["index", "sku", "reason"], properties: {
          index: { type: "integer" }, sku: { type: ["string", "null"] }, reason: { type: "string" },
        } } },
      } },
    } },
    messages: [
      { role: "system", content: "For each ingredient choose the best matching grocery product from its candidates. Do not choose ready meals, baby food, utensils, mixtures containing different meat, or a different ingredient. Do not replace a specific ingredient with a different one. Consider dietary notes but never claim allergy safety. Prefer a suitable lower total price. If none is suitable return null. Return one entry per index and use only candidate SKU values. Explain your choice briefly without inventing information." },
      { role: "user", content: JSON.stringify({ dietaryNotes: input.dietaryNotes, groups: groups.map((g, index) => ({ index, ingredient: g.ingredient, candidates: g.candidates.map((p) => ({ sku: p.sku, name: p.name, totalCents: p.totalCents, stockKnown: p.stockKnown })) })) }) },
    ],
  });
  const content = result.choices[0]?.message.content;
  if (!content || result.choices[0]?.message.refusal) throw new Error("Could not select ingredient products. Try again.");
  const parsed = z.object({ matches: z.array(z.object({ index: z.number().int(), sku: z.string().nullable(), reason: z.string().max(1000) })) }).parse(JSON.parse(content));
  const used = new Set<string>();
  return groups.map((group, index) => {
    const matches = parsed.matches.filter((m) => m.index === index);
    const choice = matches.length === 1 ? group.candidates.find((p) => p.sku === matches[0].sku && !used.has(p.sku)) : undefined;
    if (choice) used.add(choice.sku);
    return { ingredient: group.ingredient, product: choice ?? null, reason: choice ? "Suggested match from price-ranked catalog results. Check the product details before ordering." : "No suitable product could be selected automatically. Search or edit this ingredient." };
  });
}

type QuotedIngredient = Awaited<ReturnType<ValioProvider["quoteIngredients"]>>[number];
type BasketLine = { ingredient: string; sku: string; name: string; packs: number; priceCents: number; lineTotalCents: number; deliveryDate: string; stockKnown: boolean; packWeightG: number | null };
export interface BasketDetails {
  input: BasketInput;
  lines: BasketLine[];
  totalCents: number;
  approvalReasons: string[];
}
interface BasketRow { id: string; status: string; created_by: string; details_json: string; fingerprint: string; provider_order_id: string | null; approved_by: string | null; }

export class BasketService {
  constructor(private db: DB, private provider: ValioProvider, private clock: Clock, private simulation: boolean, private autoLimitCents: number) {}

  private validateDate(date: string) {
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || date < helsinkiDate(this.clock.now()))
      throw new ServiceError(400, "INVALID_DELIVERY_DATE", "Choose a valid delivery date that is not in the past.");
  }

  async search(query: string, date: string) {
    this.validateDate(date);
    const offers = await this.provider.searchIngredients(query, date);
    return offers.filter((o) => o.priceCents != null && !o.salesBlock && o.deliveryDate && o.deliveryDate <= date && o.availablePacks > 0)
      .sort((a, b) => a.priceCents! - b.priceCents!)
      .map((o) => ({ sku: o.sku, name: o.name, priceCents: o.priceCents, availablePacks: o.availablePacks, stockKnown: o.stockKnown, deliveryDate: o.deliveryDate, packWeightG: o.packWeightG, attributes: o.attributes }));
  }

  private async terms(input: BasketInput): Promise<BasketDetails> {
    this.validateDate(input.deliveryDate);
    if (new Set(input.lines.map((l) => l.sku)).size !== input.lines.length)
      throw new ServiceError(400, "DUPLICATE_SKU", "Combine quantities for duplicate products before reviewing the basket.");
    const offers = await this.provider.quoteIngredients(input.lines.map((l) => l.sku), input.deliveryDate);
    const bySku = new Map(offers.map((o) => [o.sku, o]));
    const lines = input.lines.map((l): BasketLine => {
      const o: QuotedIngredient | undefined = bySku.get(l.sku);
      if (!o || o.priceCents == null || !o.deliveryDate || o.deliveryDate > input.deliveryDate || o.salesBlock || o.availablePacks < l.packs)
        throw new ServiceError(409, "PRODUCT_UNAVAILABLE", `${l.ingredient}: product ${l.sku} is unavailable, has insufficient stock, or cannot arrive by the deadline. Search again.`);
      if (l.requiredGrams != null && (!o.packWeightG || o.packWeightG * l.packs < l.requiredGrams))
        throw new ServiceError(409, "QUANTITY_UNVERIFIED", `${l.ingredient}: pack weight is missing or no longer covers the approved quantity. Search again.`);
      return { ingredient: l.ingredient, sku: l.sku, name: o.name, packs: l.packs, priceCents: o.priceCents, lineTotalCents: l.packs * o.priceCents, deliveryDate: o.deliveryDate, stockKnown: o.stockKnown, packWeightG: o.packWeightG };
    });
    const totalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
    const approvalReasons: string[] = [];
    if (totalCents > this.autoLimitCents) approvalReasons.push(`Total ${formatEur(totalCents)} exceeds the automatic limit of ${formatEur(this.autoLimitCents)}.`);
    if (input.budgetIsLimit && input.budgetCents != null && totalCents > input.budgetCents) approvalReasons.push(`Total ${formatEur(totalCents)} exceeds your budget limit of ${formatEur(input.budgetCents)}.`);
    return { input, lines, totalCents, approvalReasons };
  }

  async preview(input: BasketInput) {
    const details = await this.terms(input);
    return { details, fingerprint: sha256(canonicalJson(details)) };
  }

  private row(id: string): BasketRow {
    const row = this.db.prepare("SELECT * FROM ingredient_baskets WHERE id=?").get(id) as BasketRow | undefined;
    if (!row) throw new ServiceError(404, "BASKET_NOT_FOUND", "Basket not found.");
    return row;
  }

  get(id: string) {
    const row = this.row(id);
    return { id: row.id, status: row.status, details: JSON.parse(row.details_json) as BasketDetails, fingerprint: row.fingerprint, providerOrderId: row.provider_order_id, approvedBy: row.approved_by };
  }

  list() {
    const rows = this.db.prepare("SELECT id FROM ingredient_baskets ORDER BY created_at DESC, id DESC").all() as Array<{ id: string }>;
    return rows.map(({ id }) => this.get(id));
  }

  async create(actor: Actor, input: BasketInput, fingerprint: string) {
    if (!["buyer", "agent"].includes(actor.role)) throw new ServiceError(403, "FORBIDDEN_ROLE", "Only a buyer or agent can create a basket.");
    if (!this.simulation) throw new ServiceError(409, "SIMULATION_DISABLED", "Simulated Valio ordering is disabled.");
    const fresh = await this.preview(input);
    if (fresh.fingerprint !== fingerprint) throw new ServiceError(409, "BASKET_CHANGED", "The basket changed since review. Refresh prices and review it again.");
    const id = `BASKET-${String(nextCounter(this.db, "ingredient_basket")).padStart(4, "0")}`;
    const now = this.clock.now().toISOString();
    const status = fresh.details.approvalReasons.length ? "awaiting_approval" : "approved";
    this.db.prepare("INSERT INTO ingredient_baskets (id,status,created_by,details_json,fingerprint,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, status, actor.id, JSON.stringify(fresh.details), fresh.fingerprint, now, now);
    return this.get(id);
  }

  private async assertFresh(row: BasketRow) {
    const details: BasketDetails = JSON.parse(row.details_json);
    const fresh = await this.preview(details.input);
    if (fresh.fingerprint !== row.fingerprint) throw new ServiceError(409, "BASKET_CHANGED", "Prices, availability or delivery changed. Review a new basket before continuing.");
  }

  async approve(actor: Actor, id: string, fingerprint: string) {
    if (actor.role !== "approver") throw new ServiceError(403, "FORBIDDEN_ROLE", "A manager must approve this basket.");
    const row = this.row(id);
    if (row.created_by === actor.id) throw new ServiceError(403, "SEPARATION_OF_DUTIES", "The requester cannot approve their own basket.");
    if (row.status !== "awaiting_approval" || row.fingerprint !== fingerprint) throw new ServiceError(409, "STALE_BASKET", "This basket is not awaiting approval for these terms.");
    await this.assertFresh(row);
    const result = this.db.prepare("UPDATE ingredient_baskets SET status='approved',approved_by=?,updated_at=? WHERE id=? AND status='awaiting_approval' AND fingerprint=?")
      .run(actor.id, this.clock.now().toISOString(), id, fingerprint);
    if (!result.changes) throw new ServiceError(409, "STALE_BASKET", "The basket changed during approval.");
    return this.get(id);
  }

  reject(actor: Actor, id: string, fingerprint: string) {
    if (actor.role !== "approver") throw new ServiceError(403, "FORBIDDEN_ROLE", "A manager must reject this basket.");
    const row = this.row(id);
    if (row.created_by === actor.id) throw new ServiceError(403, "SEPARATION_OF_DUTIES", "The requester cannot review their own basket.");
    const result = this.db.prepare("UPDATE ingredient_baskets SET status='rejected',approved_by=?,updated_at=? WHERE id=? AND status='awaiting_approval' AND fingerprint=?")
      .run(actor.id, this.clock.now().toISOString(), id, fingerprint);
    if (!result.changes) throw new ServiceError(409, "STALE_BASKET", "This basket is not awaiting review for these terms.");
    return this.get(id);
  }

  async submit(actor: Actor, id: string, fingerprint: string) {
    if (!["buyer", "agent", "approver"].includes(actor.role)) throw new ServiceError(403, "FORBIDDEN_ROLE", "This role cannot record a basket.");
    if (!this.simulation) throw new ServiceError(409, "SIMULATION_DISABLED", "Simulated Valio ordering is disabled.");
    const row = this.row(id);
    if (row.status === "submitted" && row.fingerprint === fingerprint) return this.get(id);
    if (row.status !== "approved" || row.fingerprint !== fingerprint) throw new ServiceError(409, "NOT_APPROVED", "Review and approve these basket terms first.");
    await this.assertFresh(row);
    return this.db.transaction(() => {
      const current = this.row(id);
      if (current.status === "submitted" && current.fingerprint === fingerprint) return this.get(id);
      if (current.status !== "approved" || current.fingerprint !== fingerprint) throw new ServiceError(409, "STALE_BASKET", "The basket changed before submission.");
      const details: BasketDetails = JSON.parse(current.details_json);
      const reference = `DEMO-${helsinkiDate(this.clock.now()).replaceAll("-", "")}-${String(nextCounter(this.db, "simulated_order")).padStart(4, "0")}`;
      const now = this.clock.now().toISOString();
      this.db.prepare("INSERT INTO provider_orders (id,submission_key,lines_json,total_cents,created_at) VALUES (?,?,?,?,?)")
        .run(reference, sha256(`basket:${id}:${fingerprint}`), JSON.stringify(details.lines), details.totalCents, now);
      this.db.prepare("UPDATE ingredient_baskets SET status='submitted',provider_order_id=?,updated_at=? WHERE id=?").run(reference, now, id);
      return this.get(id);
    })();
  }
}
