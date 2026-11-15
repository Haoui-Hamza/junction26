# Aimo Order Guard

A purchasing-workflow prototype for the Valio Aimo Junction 2026 challenge. It compares eligible supplier offers, combines SKUs to recover from partial stock, routes out-of-policy orders for human approval, and requires a fresh approval when an approved offer changes.

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The single `npm run dev` command starts the API and Vite UI. Local seeded data is the default and needs no credentials.

## LLM and MCP agent

Copy `.env.example` to `.env`, then set `OPENAI_API_KEY` to enable the OpenAI-powered shopping assistant. The key stays on the server. `OPENAI_MODEL` selects the model (default `gpt-4o-mini`). Without a key, use **Start my order** to enter request details manually.

```bash
cp .env.example .env
# Add your OpenAI key to OPENAI_API_KEY in .env, then restart npm run dev.
```

With the key configured, **Find options with Aimo** opens a guided order dialog and streams friendly progress. The backend interprets the request, starts the stdio MCP server as a client, and gives the LLM only these search tools:

- `search_products`
- `compare_offers`

The assistant never creates an order on its own. The buyer reviews the recommendation and chooses to continue; an order above a stated hard budget or the automatic spending policy waits for manager approval. A phrase such as “budget limit” is treated as a limit, while “if possible” or “ideally” is treated as a target. Dairy and plant-based milk are separate categories, and vegan requirements are checked against explicit product claims in the milk workflow.

Meal and other ingredient requests open a separate guided basket with `PROVIDER=valio`. Enter servings, delivery date, budget and dietary needs; with OpenAI configured, Aimo estimates essential ingredient amounts for the buyer to approve and automatically suggests matching products with enough whole packs. Suggestions are estimates, not a recipe or allergen guarantee. Review and adjust ingredients, quantities, product labels and allergies; dietary notes are not automatically enforced. If no suitable product with a known sales-pack weight is found, the buyer must change the ingredient or search for an alternative with a different search term. Automatic search falls back to a broader name when no usable exact-name matches exist, checks up to 100 name matches per search, and evaluates up to 30 price-ranked candidates per ingredient, so choices are not guaranteed optimal. Terminal stock is unconfirmed. The buyer reviews fresh prices, and a manager must approve a basket over the automatic or stated hard budget; terms are rechecked before approval and simulated recording. Baskets are saved in recent orders. No order is sent to Valio.

The MCP server also exposes order-request and status tools to standalone MCP clients. Human approval and rejection always remain separate approver-only actions.

You can also run the MCP server separately after starting the API:

```bash
npm run mcp
```

## Providers

- `PROVIDER=local` (default): deterministic SQLite-backed offers and provider order simulation.
- `PROVIDER=valio`: reads static product facts from `AIMO_PRODUCT_DATA` and uses the Valio mock API for live price and availability. Set `AIMO_API_KEY` server-side. The adapter only queries SKUs that pass static requirements, in batches no larger than 1,000. `SIMULATE_VALIO_ORDERS=true` (default for Valio) enables simulated approval and order confirmation using those live quotes; simulated orders are saved locally and are never sent to Valio. Set it to `false` to disable simulated order placement.

The challenge API documents price, availability, ping, and static-file download operations, but no order creation endpoint. Valio quote revalidation is live; simulated submissions use local references and must not be mistaken for supplier confirmations. Terminal availability quantities are placeholders and are not represented as confirmed stock.

Comparisons limit the amount of combination-search work to keep large catalogs responsive. If the limit is reached, the result says the search was incomplete; an offered exact match remains valid, but the lowest possible price is not guaranteed. If no match was found, try a smaller quantity or a specific product.

## Sample walkthrough

The local sample uses a fixed Helsinki clock and seeded offers. Expand **Sample controls** at the top of the UI:

1. Select **Load 100 L example** and run the structured fallback or configured agent. The local provider automatically submits the qualifying €120 order.
2. Reset fixtures and select **Load 1,000 L stock-recovery request**. SKU A covers 600 L; A + B covers 1,000 L for €1,240, €160 less than the best single SKU. This is €40 over the €1,200 automatic limit, so an approver must act. The same request can be entered as: “We need 1,000 litres of lactose-free milk delivered by Monday. Find the cheapest option, and combine products if one product doesn't have enough stock.”
3. Approve revision 1. Change B's price to €14.75 before submitting. Revalidation pauses the order and presents the €1,310 replacement revision (+€70) side by side with the approved terms.
4. Approve the revised terms and submit. Only the revised order is created; its provider confirmation and full decision history appear in the UI.

The LLM may be skipped when testing the deterministic workflow. **Review request details** is available regardless of credentials.

## HTTP API

The interactive OpenAPI document is served at `/openapi.json` (for example `http://localhost:3000/openapi.json`). API calls use the seeded agent bearer token in local sample mode:

```bash
curl http://localhost:3000/api/v1/compare_offers \
  -H 'Authorization: Bearer demo-agent-token' \
  -H 'Content-Type: application/json' \
  -d '{
    "request": {
      "category": "milk",
      "requiredAttributes": ["lactose_free"],
      "quantity": 1000,
      "unit": "L",
      "latestDeliveryDate": "2026-11-16",
      "preferredBudgetCents": 120000,
      "requestedSku": null
    }
  }'
```

The home screen's **Available products** section uses the public, read-only `GET /api/v1/catalog` endpoint to show current quotes in a one-week delivery window. Catalog quotes are cached for one minute and checked again when an order is requested. Other ordering and order-history operations require authentication. The API also exposes `POST /api/v1/search_products`, `POST /api/v1/request_order`, `GET /api/v1/orders/:id`, `POST /api/v1/orders/:id/approve`, `POST /api/v1/orders/:id/reject`, and `POST /api/v1/orders/:id/submit`. The LLM/MCP event stream is `POST /api/v1/agent/run`; it requires a configured LLM key and sends Server-Sent Events.

## Checks

```bash
npm test
npm run typecheck
npm run build
```
