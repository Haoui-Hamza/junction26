// Exercises the MCP adapter end-to-end against a running server: lists tools, compares, requests an order, reads status.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "npx", args: ["tsx", "mcp/server.ts"], env: { ...process.env } as Record<string, string> });
const client = new Client({ name: "mcp-smoke", version: "0.0.1" });
await client.connect(transport);
const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
const request = { category: "milk", requiredAttributes: ["lactose_free"], quantity: 1000, unit: "L", latestDeliveryDate: "2026-11-16", preferredBudgetCents: 120000 };
const text = (r: any) => JSON.parse(r.content[0].text);
const cmp = text(await client.callTool({ name: "compare_offers", arguments: { request } }));
console.log("compare_offers:", cmp.recommendedKind, cmp.recommended?.totalCents, "savings", cmp.savingsCents);
const ord = text(await client.callTool({ name: "request_order", arguments: { request, clientRequestId: `mcp-smoke-${Date.now()}` } }));
console.log("request_order:", ord.outcome, ord.orderId, ord.nextAction, ord.reasonCodes.map((r: any) => r.code).join(","));
const st = text(await client.callTool({ name: "get_order_status", arguments: { orderId: ord.orderId } }));
console.log("get_order_status:", st.status, "rev", st.revision, "provider order", st.providerOrderId);
await client.close();
