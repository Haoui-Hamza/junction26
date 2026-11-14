import { nextCounter, type DB } from "../db.js";
import { helsinkiDate, type Clock } from "../domain/util.js";
import type { Provider, ProviderInfo, SubmitOrderInput } from "./provider.js";

/** Adds local, explicitly simulated order records without sending them to the quote provider. */
export class SimulatedOrderProvider implements Provider {
  readonly info: ProviderInfo;

  constructor(private quotes: Provider, private db: DB, private clock: Clock) {
    this.info = {
      ...quotes.info,
      label: `${quotes.info.label} · demo order simulator`,
      description: `${quotes.info.description} Orders are recorded locally as simulations and are never sent to Valio.`,
      orderMode: "simulated",
      capabilities: {
        ...quotes.info.capabilities,
        submitOrders: true,
        conditionalSubmit: false,
        idempotentSubmit: true,
        orderLookup: true,
      },
      gaps: [...quotes.info.gaps, "Order placement is simulated locally; no order is submitted to Valio."],
    };
  }

  searchOffers = (req: Parameters<Provider["searchOffers"]>[0]) => this.quotes.searchOffers(req);
  quoteOffers = (skus: string[], requestedDeliveryDate: string) => this.quotes.quoteOffers(skus, requestedDeliveryDate);

  async submitOrder(input: SubmitOrderInput): Promise<{ providerOrderId: string }> {
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM provider_orders WHERE submission_key=?").get(input.submissionKey) as { id: string } | undefined;
      if (existing) return { providerOrderId: existing.id };
      const sequence = nextCounter(this.db, "simulated_order");
      const id = `DEMO-${helsinkiDate(this.clock.now()).replaceAll("-", "")}-${String(sequence).padStart(4, "0")}`;
      this.db
        .prepare("INSERT INTO provider_orders (id,submission_key,lines_json,total_cents,created_at) VALUES (?,?,?,?,?)")
        .run(id, input.submissionKey, JSON.stringify(input.lines), input.expectedTotalCents, this.clock.now().toISOString());
      return { providerOrderId: id };
    })();
  }

  async findOrderBySubmissionKey(submissionKey: string): Promise<{ providerOrderId: string } | null> {
    const result = this.db.prepare("SELECT id FROM provider_orders WHERE submission_key=?").get(submissionKey) as { id: string } | undefined;
    return result ? { providerOrderId: result.id } : null;
  }
}
