/**
 * Thin MCP adapter (stdio) over the Aimo Order Guard HTTP API.
 * All pricing, policy and order logic stays in the backend; this only forwards calls with the agent's token.
 * Human approval is intentionally NOT exposed here: it stays on the buyer's side (approver role in the UI/API).
 *
 *   ORDER_GUARD_URL=http://localhost:3000 AGENT_TOKEN=demo-agent-token npm run mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.ORDER_GUARD_URL || "http://localhost:3000").replace(/\/$/, "");
const TOKEN = process.env.AGENT_TOKEN || "demo-agent-token";

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: { code: "BAD_RESPONSE", message: `HTTP ${res.status}` } }));
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], isError: !res.ok && res.status !== 422 };
}

const request = z
  .object({
    rawText: z.string().optional().describe("The kitchen's original wording"),
    category: z.enum(["milk", "plant_milk"]),
    requiredAttributes: z.array(z.enum(["lactose_free", "organic", "vegan"])).default([]),
    quantity: z.number().positive().describe("Litres"),
    unit: z.literal("L"),
    latestDeliveryDate: z.string().describe("YYYY-MM-DD, Europe/Helsinki"),
    preferredBudgetCents: z.number().int().nullable().optional().describe("Buyer preference only; policy limit is set by the service"),
    budgetIsLimit: z.boolean().optional().describe("True when the buyer's budget must not be exceeded"),
    requestedSku: z.string().nullable().optional().describe("Explicit SKU; prevents substitution"),
  })
  .describe("Structured purchase request");

const server = new McpServer({ name: "aimo-order-guard", version: "0.1.0" });

server.registerTool(
  "search_products",
  { description: "Structured product, fixed price, stock and delivery lookup for a purchase request. Returns eligible SKUs and exclusion reasons.", inputSchema: { request } },
  async ({ request }) => api("POST", "/search_products", { request }),
);

server.registerTool(
  "compare_offers",
  { description: "Rank the best single-SKU order and the best combined (exact whole-pack) order for a request, with savings and exclusion reasons.", inputSchema: { request } },
  async ({ request }) => api("POST", "/compare_offers", { request }),
);

server.registerTool(
  "request_order",
  {
    description:
      "Send a proposal through policy evaluation. Returns outcome submitted | approval_required | requote_required | no_eligible_offer | submission_outcome_unknown, with reasonCodes and nextAction. The agent cannot approve; a human approver does.",
    inputSchema: {
      request,
      option: z.enum(["recommended", "single", "combined"]).optional(),
      clientRequestId: z.string().optional().describe("Idempotency key; retries with the same id return the same order"),
    },
  },
  async (args) => api("POST", "/request_order", args),
);

server.registerTool(
  "get_order_status",
  { description: "Current revision, status, outcome, next action, decision history and provider order ID for an order.", inputSchema: { orderId: z.string() } },
  async ({ orderId }) => api("GET", `/orders/${encodeURIComponent(orderId)}`),
);

await server.connect(new StdioServerTransport());
