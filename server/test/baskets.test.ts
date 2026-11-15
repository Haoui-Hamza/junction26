import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv, createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { makeClock } from "../src/domain/util.js";
import { BasketService, recommendIngredients } from "../src/baskets.js";
import { ValioProvider } from "../src/providers/valio.js";

const agent = { Authorization: "Bearer demo-agent-token" };
const approver = { Authorization: "Bearer demo-approver-token" };
const date = "2026-11-16";

function setup(simulation = true) {
  const cfg = configFromEnv({ PROVIDER: "valio", AIMO_API_KEY: "test", SIMULATE_VALIO_ORDERS: String(simulation) } as NodeJS.ProcessEnv);
  const db = openDb(":memory:");
  const app = createApp(cfg, { db, clock: makeClock("2026-11-13T09:00:00+02:00") }).app;
  let price = 2;
  let stock = 100;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { products: string[] };
    if (url.endsWith("/price")) return Response.json({ products: body.products.map((productId) => ({ productId, catalogPrice: { value: price } })) });
    return Response.json({ products: body.products.map((productId) => ({ productId, logisticModel: "Warehouse", scheduleLines: [{ availableAmount: stock, availableDate: date }] })) });
  }));
  return { app, db, setPrice: (value: number) => { price = value; }, setStock: (value: number) => { stock = value; } };
}
afterEach(() => vi.unstubAllGlobals());

const input = {
  description: "Spaghetti bolognese for 10 people", deliveryDate: date, dietaryNotes: "Check allergens",
  budgetCents: 500, budgetIsLimit: true,
  lines: [{ ingredient: "spaghetti", sku: "460293", packs: 2 }, { ingredient: "minced beef", sku: "463132", packs: 2 }],
};

describe("ingredient baskets", () => {
  it("finds ingredients across the full catalog, not just milk", async () => {
    const { app } = setup();
    const search = await request(app).post("/api/v1/baskets/search").send({ query: "spaghetti", deliveryDate: date }).expect(200);
    expect(search.body.products.some((p: { sku: string }) => p.sku === "460293")).toBe(true);
    const classified = await request(app).post("/api/v1/assistant/classify").send({ text: "Ingredients for spaghetti bolognese" }).expect(200);
    expect(classified.body.kind).toBe("basket");
  });

  it("binds review, manager approval and idempotent simulation to fresh basket terms", async () => {
    const { app, db } = setup();
    const preview = await request(app).post("/api/v1/baskets/preview").send(input).expect(200);
    expect(preview.body.details.totalCents).toBe(800);
    expect(preview.body.details.approvalReasons.join(" ")).toMatch(/budget limit/);
    const created = await request(app).post("/api/v1/baskets").set(agent).send({ input, fingerprint: preview.body.fingerprint }).expect(200);
    expect(created.body.status).toBe("awaiting_approval");
    const id = created.body.id;
    await request(app).post(`/api/v1/baskets/${id}/submit`).set(agent).send({ fingerprint: preview.body.fingerprint }).expect(409);
    await request(app).post(`/api/v1/baskets/${id}/approve`).set(agent).send({ fingerprint: preview.body.fingerprint }).expect(403);
    await request(app).post(`/api/v1/baskets/${id}/approve`).set(approver).send({ fingerprint: preview.body.fingerprint }).expect(200);
    const submitted = await request(app).post(`/api/v1/baskets/${id}/submit`).set(agent).send({ fingerprint: preview.body.fingerprint }).expect(200);
    expect(submitted.body.status).toBe("submitted");
    expect(submitted.body.providerOrderId).toMatch(/^DEMO-/);
    const again = await request(app).post(`/api/v1/baskets/${id}/submit`).set(agent).send({ fingerprint: preview.body.fingerprint }).expect(200);
    expect(again.body.providerOrderId).toBe(submitted.body.providerOrderId);
    expect((db.prepare("SELECT COUNT(*) AS n FROM provider_orders").get() as { n: number }).n).toBe(1);
    const saved = await request(app).get("/api/v1/baskets").set(agent).expect(200);
    expect(saved.body.baskets[0].id).toBe(id);
  });

  it("rejects price or stock changes without recording an order", async () => {
    const { app, db, setPrice, setStock } = setup();
    const preview = await request(app).post("/api/v1/baskets/preview").send(input).expect(200);
    setPrice(3);
    await request(app).post("/api/v1/baskets").set(agent).send({ input, fingerprint: preview.body.fingerprint }).expect(409);
    setPrice(2);
    const created = await request(app).post("/api/v1/baskets").set(agent).send({ input, fingerprint: preview.body.fingerprint }).expect(200);
    setStock(1);
    await request(app).post(`/api/v1/baskets/${created.body.id}/approve`).set(approver).send({ fingerprint: preview.body.fingerprint }).expect(409);
    expect((db.prepare("SELECT COUNT(*) AS n FROM provider_orders").get() as { n: number }).n).toBe(0);
  });

  it("rejects duplicate SKUs and respects disabled simulation", async () => {
    const { app } = setup(false);
    await request(app).post("/api/v1/baskets/preview").send({ ...input, lines: [input.lines[0], input.lines[0]] }).expect(400);
    const preview = await request(app).post("/api/v1/baskets/preview").send(input).expect(200);
    await request(app).post("/api/v1/baskets").set(agent).send({ input, fingerprint: preview.body.fingerprint }).expect(409);
  });

  it("does not submit rejected baskets or baskets whose prices change after approval", async () => {
    const { app, db, setPrice } = setup();
    const preview = await request(app).post("/api/v1/baskets/preview").send(input).expect(200);
    const first = await request(app).post("/api/v1/baskets").set(agent).send({ input, fingerprint: preview.body.fingerprint }).expect(200);
    await request(app).post(`/api/v1/baskets/${first.body.id}/reject`).set(agent).send({ fingerprint: preview.body.fingerprint }).expect(403);
    const rejected = await request(app).post(`/api/v1/baskets/${first.body.id}/reject`).set(approver).send({ fingerprint: preview.body.fingerprint }).expect(200);
    expect(rejected.body.status).toBe("rejected");
    await request(app).post(`/api/v1/baskets/${first.body.id}/submit`).set(agent).send({ fingerprint: preview.body.fingerprint }).expect(409);
    const second = await request(app).post("/api/v1/baskets").set(agent).send({ input, fingerprint: preview.body.fingerprint }).expect(200);
    await request(app).post(`/api/v1/baskets/${second.body.id}/approve`).set(approver).send({ fingerprint: preview.body.fingerprint }).expect(200);
    setPrice(3);
    await request(app).post(`/api/v1/baskets/${second.body.id}/submit`).set(agent).send({ fingerprint: preview.body.fingerprint }).expect(409);
    expect((db.prepare("SELECT COUNT(*) AS n FROM provider_orders").get() as { n: number }).n).toBe(0);
  });

  it("uses only returned candidates, checks meat type and calculates whole packs", async () => {
    const { db } = setup();
    const service = new BasketService(db, new ValioProvider({ baseUrl: "https://example.test", apiKey: "test", productDataPath: "unused" }), makeClock("2026-11-13T09:00:00+02:00"), true, 120000);
    vi.spyOn(service, "search").mockResolvedValue([
      { sku: "mixed", name: "Minced beef-pork", priceCents: 50, availablePacks: 100, stockKnown: true, deliveryDate: date, packWeightG: 1000, attributes: {} },
      { sku: "beef", name: "Minced beef", priceCents: 300, availablePacks: 100, stockKnown: true, deliveryDate: date, packWeightG: 2000, attributes: {} },
      { sku: "unknown", name: "Minced beef", priceCents: 10, availablePacks: 100, stockKnown: true, deliveryDate: date, packWeightG: null, attributes: {} },
    ]);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const supplied = JSON.parse(body.messages[1].content);
      expect(supplied.groups[0].candidates.map((c: { sku: string }) => c.sku)).toEqual(["beef"]);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ matches: [{ index: 0, sku: "beef", reason: "Suitable beef" }] }) } }] });
    }));
    const result = await recommendIngredients(service, { deliveryDate: date, dietaryNotes: "", ingredients: [{ name: "minced beef", grams: 4500 }] }, "test", "test-model");
    expect(result[0].product).toMatchObject({ sku: "beef", packs: 3, totalCents: 900 });
  });

  it("tries a broader catalog search when exact matches lack usable pack weights", async () => {
    const { db } = setup();
    const service = new BasketService(db, new ValioProvider({ baseUrl: "https://example.test", apiKey: "test", productDataPath: "unused" }), makeClock("2026-11-13T09:00:00+02:00"), true, 120000);
    const search = vi.spyOn(service, "search");
    search.mockResolvedValueOnce([
      { sku: "unknown", name: "Crushed tomatoes", priceCents: 100, availablePacks: 100, stockKnown: true, deliveryDate: date, packWeightG: null, attributes: {} },
    ]).mockResolvedValueOnce([
      { sku: "chopped", name: "Finely chopped tomatoes", priceCents: 200, availablePacks: 100, stockKnown: true, deliveryDate: date, packWeightG: 400, attributes: {} },
    ]);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const supplied = JSON.parse(body.messages[1].content);
      expect(supplied.groups[0].candidates.map((c: { sku: string }) => c.sku)).toEqual(["chopped"]);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ matches: [{ index: 0, sku: "chopped", reason: "Allergen safe" }] }) } }] });
    }));
    const result = await recommendIngredients(service, { deliveryDate: date, dietaryNotes: "", ingredients: [{ name: "crushed tomatoes", grams: 3000 }] }, "test", "test-model");
    expect(search.mock.calls.map(([query]) => query)).toEqual(["crushed tomatoes", "tomato"]);
    expect(result[0].product?.packs).toBe(8);
    expect(result[0].reason).not.toContain("Allergen safe");
  });

  it("limits simultaneous ingredient searches and preserves ingredient order", async () => {
    const { db } = setup();
    const service = new BasketService(db, new ValioProvider({ baseUrl: "https://example.test", apiKey: "test", productDataPath: "unused" }), makeClock("2026-11-13T09:00:00+02:00"), true, 120000);
    let active = 0;
    let peak = 0;
    vi.spyOn(service, "search").mockImplementation(async (query) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return [{ sku: query, name: query, priceCents: 100, availablePacks: 10, stockKnown: true, deliveryDate: date, packWeightG: 1000, attributes: {} }];
    });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const supplied = JSON.parse(body.messages[1].content);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ matches: supplied.groups.map((group: { index: number; candidates: Array<{ sku: string }> }) => ({ index: group.index, sku: group.candidates[0].sku, reason: "Match" })) }) } }] });
    }));
    const ingredients = ["spaghetti", "beef", "onion", "carrot", "garlic"].map((name) => ({ name, grams: 100 }));
    const result = await recommendIngredients(service, { deliveryDate: date, dietaryNotes: "", ingredients }, "test", "test-model");
    expect(peak).toBe(3);
    expect(result.map((item) => item.ingredient.name)).toEqual(ingredients.map((item) => item.name));
  });

  it("does not accept an invented product or insufficient reviewed weight", async () => {
    const { app, db } = setup();
    const service = new BasketService(db, new ValioProvider({ baseUrl: "https://example.test", apiKey: "test", productDataPath: "unused" }), makeClock("2026-11-13T09:00:00+02:00"), true, 120000);
    vi.spyOn(service, "search").mockResolvedValue([]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify({ matches: [{ index: 0, sku: "invented", reason: "Guess" }] }) } }] })));
    const recommendations = await recommendIngredients(service, { deliveryDate: date, dietaryNotes: "", ingredients: [{ name: "spaghetti", grams: 1000 }] }, "test", "test-model");
    expect(recommendations[0].product).toBeNull();
    const valioFetch = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { products: string[] };
      return Response.json({ products: body.products.map((productId) => url.endsWith("/price")
        ? { productId, catalogPrice: { value: 2 } }
        : { productId, logisticModel: "Warehouse", scheduleLines: [{ availableAmount: 100, availableDate: date }] }) });
    });
    vi.stubGlobal("fetch", valioFetch);
    const invalid = { ...input, lines: [{ ingredient: "spaghetti", sku: "460293", packs: 1, requiredGrams: 1000 }] };
    const response = await request(app).post("/api/v1/baskets/preview").send(invalid).expect(409);
    expect(response.body.error.code).toBe("QUANTITY_UNVERIFIED");
  });
});
