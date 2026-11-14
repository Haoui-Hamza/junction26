import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareOffers } from "../src/domain/compare.js";
import { req } from "./helpers.js";
import { ProviderNotSupportedError } from "../src/providers/provider.js";
import { ValioProvider } from "../src/providers/valio.js";

const PRODUCT_DATA = resolve("data/valio_aimo_junction26_product_data.json");

function provider(apiKey: string | undefined) {
  return new ValioProvider({
    baseUrl: "https://junction26.valioaimo.fi/api",
    apiKey,
    productDataPath: PRODUCT_DATA,
    customer: "test-customer",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Valio provider", () => {
  it("queries only statically eligible SKUs and marks terminal availability as unconfirmed", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const body = JSON.parse(String(init?.body)) as { customer: string; requestedDate: string; products: string[] };
      if (url.pathname === "/api/price") {
        return Response.json({
          products: body.products.map((productId) => ({
            productId,
            error: false,
            catalogPrice: { value: 12.345 },
          })),
        });
      }
      return Response.json({
        products: body.products.map((productId) => ({
          productId,
          closingTime: "2026-11-15T12:00:00+02:00",
          salesBlock: false,
          logisticModel: "Terminal",
          scheduleLines: [{ availableAmount: 999999, availableDate: "2026-11-16", salesUnit: "ST", salesBlock: false }],
        })),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = req(1, { requestedSku: "462775" });
    const offers = await provider("test-api-key").searchOffers(request);
    const offer = offers.find((candidate) => candidate.sku === "462775");

    expect(offer).toMatchObject({
      name: "Arla Milkdrink 1L lactose free fat free UHT Suomesta",
      packVolumeMl: 1000,
      priceCents: 1235,
      availablePacks: 999999,
      stockKnown: false,
      deliveryDate: "2026-11-16",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [input, init] of fetchMock.mock.calls) {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const body = JSON.parse(String(init?.body)) as { customer: string; requestedDate: string; products: string[] };
      expect(body).toEqual({ customer: "test-customer", requestedDate: request.latestDeliveryDate, products: ["462775"] });
      expect((init?.headers as Record<string, string>)["X-API-Key"]).toBe("test-api-key");
      expect(["/api/price", "/api/availability"]).toContain(url.pathname);
    }

    const comparison = compareOffers(request, offers);
    expect(comparison.single?.qualifies).toContain(
      "Supplier quantity is unconfirmed for 462775; confirm availability before ordering.",
    );
    expect(comparison.single?.qualifies).not.toContain("Pack counts are within confirmed stock");
  });

  it("surfaces API HTTP errors and reports order creation as unsupported", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 403 })));

    await expect(provider("test-api-key").quoteOffers(["462775"], "2026-11-16")).rejects.toThrow("Valio API /price returned HTTP 403");
    await expect(
      provider("test-api-key").submitOrder({
        submissionKey: "test",
        lines: [],
        expectedTotalCents: 0,
        currency: "EUR",
        requestedDeliveryDate: "2026-11-16",
      }),
    ).rejects.toBeInstanceOf(ProviderNotSupportedError);
  });

  it("finds plant-based milk using explicit vegan claim evidence", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const body = JSON.parse(String(init?.body)) as { products: string[] };
      if (url.pathname === "/api/price") {
        return Response.json({ products: body.products.map((productId) => ({ productId, error: false, catalogPrice: { value: 1.25 } })) });
      }
      return Response.json({
        products: body.products.map((productId) => ({
          productId,
          closingTime: "2026-11-15T12:00:00+02:00",
          salesBlock: false,
          logisticModel: "Depot",
          scheduleLines: [{ availableAmount: 100, availableDate: "2026-11-16", salesUnit: "ST", salesBlock: false }],
        })),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = req(1, { category: "plant_milk", requiredAttributes: ["vegan"], requestedSku: "460416" });

    const offers = await provider("test-api-key").searchOffers(request);
    const offer = offers.find((candidate) => candidate.sku === "460416");

    expect(offer).toMatchObject({
      name: "Alpro Soya drink, vanilla 1L",
      category: "plant_milk",
      attributes: { vegan: true },
      evidence: { vegan: "Nutritional claim VEGAN" },
    });
    expect(fetchMock.mock.calls.map(([url]) => new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname)).toEqual([
      "/api/price",
      "/api/availability",
    ]);
  });

  it("fails clearly when the API key is not configured", async () => {
    await expect(provider(undefined).quoteOffers(["462775"], "2026-11-16")).rejects.toThrow("AIMO_API_KEY is not configured");
  });
});
