import { describe, expect, it, vi } from "vitest";
import { OrderService } from "../src/orders.js";
import type { Provider } from "../src/providers/provider.js";
import { SimulatedOrderProvider } from "../src/providers/simulated-orders.js";
import { agent, body, setup } from "./helpers.js";

describe("simulated orders", () => {
  it("records a local demo reference without calling the quote provider's submission method", async () => {
    const { db, clock, provider: quotes } = setup();
    const realSubmission = vi.spyOn(quotes, "submitOrder").mockRejectedValue(new Error("Must not call supplier submission"));
    const quoteProvider: Provider = {
      info: quotes.info,
      searchOffers: quotes.searchOffers.bind(quotes),
      quoteOffers: quotes.quoteOffers.bind(quotes),
      submitOrder: async (input) => quotes.submitOrder(input),
      findOrderBySubmissionKey: quotes.findOrderBySubmissionKey.bind(quotes),
    };
    const simulated = new SimulatedOrderProvider(quoteProvider, db, clock);
    const service = new OrderService(db, simulated, clock);
    const result = await service.requestOrder(agent, { request: body(100) });

    expect(result.outcome).toBe("submitted");
    expect(result.providerOrderId).toMatch(/^DEMO-20261113-/);
    expect(result.message).toMatch(/No order was sent to Valio/);
    expect(result.order?.provider.orderMode).toBe("simulated");
    if (!result.order) throw new Error("Expected the submitted order details");
    const retried = await simulated.submitOrder({
      submissionKey: result.order.submissions[0].submissionKey,
      lines: [],
      expectedTotalCents: 0,
      currency: "EUR",
      requestedDeliveryDate: "2026-11-16",
    });

    expect(retried.providerOrderId).toBe(result.providerOrderId);
    expect(realSubmission).not.toHaveBeenCalled();
  });
});
