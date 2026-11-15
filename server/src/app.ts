import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { openDb, type DB } from "./db.js";
import { parseRequestLlm, parseRequestRules, ValidationError } from "./domain/intake.js";
import type { Actor } from "./domain/types.js";
import { runPurchasingAgent } from "./agent.js";
import { BasketService, basketInputSchema, classifyRequest, recommendationSchema, recommendIngredients, suggestIngredients } from "./baskets.js";
import { describeDate, formatEur, helsinkiDate, makeClock, type Clock } from "./domain/util.js";
import { openApiDocument } from "./openapi.js";
import { OrderService, ServiceError } from "./orders.js";
import { LocalProvider, type LocalFault } from "./providers/local.js";
import type { Provider } from "./providers/provider.js";
import { SimulatedOrderProvider } from "./providers/simulated-orders.js";
import { ValioProvider } from "./providers/valio.js";

export interface AppConfig {
  dbPath: string;
  provider: "local" | "valio";
  simulateValioOrders: boolean;
  fixedClock: string | null;
  demoMode: boolean;
  advancingClock: boolean;
  tokens: { agent: string; buyer: string; approver: string };
  valio: { baseUrl: string; apiKey?: string; productDataPath: string };
  llm: { apiKey?: string; model: string };
  staticDir?: string;
}

export const DEMO_FIXED_CLOCK = "2026-11-13T09:00:00+02:00";

export function configFromEnv(env = process.env): AppConfig {
  const provider = env.PROVIDER === "valio" ? "valio" : "local";
  const fixed = env.FIXED_CLOCK !== undefined && env.FIXED_CLOCK !== "" ? env.FIXED_CLOCK : provider === "local" ? DEMO_FIXED_CLOCK : null;
  return {
    dbPath: env.DB_PATH || "./order-guard.db",
    provider,
    simulateValioOrders: env.SIMULATE_VALIO_ORDERS === undefined ? provider === "valio" : env.SIMULATE_VALIO_ORDERS === "true",
    fixedClock: fixed,
    demoMode: env.DEMO_MODE ? env.DEMO_MODE === "true" : provider === "local",
    advancingClock: true,
    tokens: {
      agent: env.AGENT_TOKEN || "demo-agent-token",
      buyer: env.BUYER_TOKEN || "demo-buyer-token",
      approver: env.APPROVER_TOKEN || "demo-approver-token",
    },
    valio: {
      baseUrl: env.AIMO_API_BASE || "https://junction26.valioaimo.fi/api",
      apiKey: env.AIMO_API_KEY || undefined,
      productDataPath: env.AIMO_PRODUCT_DATA || "./data/valio_aimo_junction26_product_data.json",
    },
    llm: { apiKey: env.OPENAI_API_KEY || undefined, model: env.OPENAI_MODEL || "gpt-4o-mini" },
  };
}

/** Fixed clock that, for live demos, advances with wall time from the fixed start so history timestamps differ. */
function buildClock(cfg: AppConfig): Clock {
  if (!cfg.fixedClock) return makeClock(null);
  if (!cfg.advancingClock) return makeClock(cfg.fixedClock);
  const start = new Date(cfg.fixedClock).getTime();
  const boot = Date.now();
  return { now: () => new Date(start + (Date.now() - boot)), fixed: true };
}

export function createApp(cfg: AppConfig, opts: { db?: DB; clock?: Clock } = {}) {
  const db = opts.db ?? openDb(cfg.dbPath);
  const clock = opts.clock ?? buildClock(cfg);
  let local: LocalProvider | null = null;
  let quoteProvider: Provider;
  if (cfg.provider === "local") {
    local = new LocalProvider(db, clock);
    quoteProvider = local;
  } else {
    quoteProvider = new ValioProvider({ baseUrl: cfg.valio.baseUrl, apiKey: cfg.valio.apiKey, productDataPath: cfg.valio.productDataPath });
  }
  const provider: Provider = cfg.provider === "valio" && cfg.simulateValioOrders
    ? new SimulatedOrderProvider(quoteProvider, db, clock)
    : quoteProvider;
  const service = new OrderService(db, provider, clock);
  const basketService = quoteProvider instanceof ValioProvider
    ? new BasketService(db, quoteProvider, clock, cfg.simulateValioOrders, service.getPolicy().autoLimitCents)
    : null;

  const actors: Record<string, Actor> = {
    [cfg.tokens.agent]: { id: "agent:kitchen-purchasing", name: "Kitchen purchasing agent", role: "agent" },
    [cfg.tokens.buyer]: { id: "user:maija", name: "Maija (buyer, central kitchen)", role: "buyer" },
    [cfg.tokens.approver]: { id: "user:olli", name: "Olli (approver, kitchen manager)", role: "approver" },
  };

  const app = express();
  app.use(express.json({ limit: "100kb" }));
  const anonymousRequests = new Map<string, { startedAt: number; count: number }>();
  const limitAnonymousRequests = (req: Request, scope: string) => {
    const now = Date.now();
    const key = `${scope}:${req.ip || req.socket.remoteAddress || "unknown"}`;
    let window = anonymousRequests.get(key);
    if (!window || now - window.startedAt >= 60_000) {
      window = { startedAt: now, count: 0 };
      anonymousRequests.set(key, window);
    }
    if (window.count >= 10)
      throw new ServiceError(429, "RATE_LIMITED", "Too many anonymous requests. Please wait a minute and try again.");
    window.count += 1;
    if (anonymousRequests.size > 10_000) {
      for (const [requestKey, requestWindow] of anonymousRequests)
        if (now - requestWindow.startedAt >= 60_000) anonymousRequests.delete(requestKey);
    }
  };
  const optionalReadActor = (req: Request, scope: string): Actor | undefined => {
    if (req.header("authorization")) return auth(req);
    limitAnonymousRequests(req, scope);
    return undefined;
  };
  const auth = (req: Request): Actor => {
    const h = req.header("authorization") ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    const actor = actors[token];
    if (!actor) throw new ServiceError(401, "UNAUTHENTICATED", "Missing or invalid bearer token");
    return actor;
  };
  const wrap =
    (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
    (req: Request, res: Response, next: NextFunction) =>
      Promise.resolve(fn(req, res))
        .then((body) => {
          if (!res.headersSent) res.json(body);
        })
        .catch(next);
  const parse = <T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw new ValidationError(r.error.issues.map((i) => ({ field: i.path.join(".") || "body", message: i.message })));
    return r.data;
  };
  const RevisionRef = z.object({ revision: z.number().int().positive(), fingerprint: z.string().min(16), reason: z.string().max(500).optional() });

  const api = express.Router();
  const baskets = () => {
    if (!basketService) throw new ServiceError(503, "BASKET_PROVIDER_UNAVAILABLE", "Ingredient search requires the Valio provider. Set PROVIDER=valio and restart the app.");
    return basketService;
  };

  api.post("/assistant/classify", wrap(async (req) => {
    optionalReadActor(req, "classify");
    const { text, manual } = parse(z.object({ text: z.string().trim().min(1).max(2000), manual: z.boolean().optional() }), req.body);
    return { kind: await classifyRequest(text, manual ? undefined : cfg.llm.apiKey, cfg.llm.model), hints: parseRequestRules(text, clock.now()).draft };
  }));
  api.post("/baskets/suggest", wrap(async (req) => {
    optionalReadActor(req, "suggest");
    const { text, servings } = parse(z.object({ text: z.string().trim().min(1).max(2000), servings: z.number().int().min(1).max(100000) }), req.body);
    if (!cfg.llm.apiKey) throw new ServiceError(503, "LLM_NOT_CONFIGURED", "Ingredient suggestions need an OpenAI key. Add ingredients manually instead.");
    return suggestIngredients(text, servings, cfg.llm.apiKey, cfg.llm.model);
  }));
  api.post("/baskets/recommend", wrap(async (req) => {
    optionalReadActor(req, "basket-recommend");
    const body = parse(recommendationSchema, req.body);
    if (!cfg.llm.apiKey) throw new ServiceError(503, "LLM_NOT_CONFIGURED", "Automatic product selection needs an OpenAI key.");
    return { recommendations: await recommendIngredients(baskets(), body, cfg.llm.apiKey, cfg.llm.model) };
  }));
  api.post("/baskets/search", wrap(async (req) => {
    optionalReadActor(req, "ingredient-search");
    const body = parse(z.object({ query: z.string().trim().min(1).max(100), deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.body);
    return { products: await baskets().search(body.query, body.deliveryDate) };
  }));
  api.post("/baskets/preview", wrap(async (req) => {
    optionalReadActor(req, "basket-preview");
    return baskets().preview(parse(basketInputSchema, req.body));
  }));
  api.post("/baskets", wrap(async (req) => {
    const actor = auth(req);
    const body = parse(z.object({ input: basketInputSchema, fingerprint: z.string().length(64) }), req.body);
    return baskets().create(actor, body.input, body.fingerprint);
  }));
  api.get("/baskets", wrap((req) => (auth(req), { baskets: baskets().list() })));
  api.get("/baskets/:id", wrap((req) => (auth(req), baskets().get(String(req.params.id)))));
  api.post("/baskets/:id/approve", wrap(async (req) => {
    const actor = auth(req);
    const { fingerprint } = parse(z.object({ fingerprint: z.string().length(64) }), req.body);
    return baskets().approve(actor, String(req.params.id), fingerprint);
  }));
  api.post("/baskets/:id/reject", wrap((req) => {
    const actor = auth(req);
    const { fingerprint } = parse(z.object({ fingerprint: z.string().length(64) }), req.body);
    return baskets().reject(actor, String(req.params.id), fingerprint);
  }));
  api.post("/baskets/:id/submit", wrap(async (req) => {
    const actor = auth(req);
    const { fingerprint } = parse(z.object({ fingerprint: z.string().length(64) }), req.body);
    return baskets().submit(actor, String(req.params.id), fingerprint);
  }));

  api.get("/config", (req, res) => {
    const now = clock.now();
    res.json({
      provider: provider.info,
      providerMode: cfg.provider,
      clock: { now: now.toISOString(), today: helsinkiDate(now), todayLabel: describeDate(helsinkiDate(now)), fixed: clock.fixed, timezone: "Europe/Helsinki" },
      policy: service.getPolicy(),
      demoMode: cfg.demoMode,
      llm: { enabled: !!cfg.llm.apiKey, model: cfg.llm.apiKey ? cfg.llm.model : null },
      // Demo identities only (never provider credentials). Exposed so the judge UI can act as each seeded actor.
      demoActors: cfg.demoMode || cfg.simulateValioOrders
        ? Object.entries(actors).map(([token, a]) => ({ ...a, token }))
        : [],
    });
  });

  api.post(
    "/intake/parse",
    wrap(async (req) => {
      optionalReadActor(req, "intake");
      const { text } = parse(z.object({ text: z.string().min(1).max(2000) }), req.body);
      if (cfg.llm.apiKey) {
        try {
          return await parseRequestLlm(text, clock.now(), cfg.llm.apiKey, cfg.llm.model);
        } catch (e: any) {
          const r = parseRequestRules(text, clock.now());
          r.notes.push(`LLM intake failed (${e?.constructor?.name ?? "error"}); used the rule-based parser`);
          return r;
        }
      }
      return parseRequestRules(text, clock.now());
    }),
  );

  api.post("/agent/run", async (req, res, next) => {
    let streamStarted = false;
    try {
      const actor = optionalReadActor(req, "agent");
      if (actor && actor.role !== "agent" && actor.role !== "buyer")
        throw new ServiceError(403, "FORBIDDEN_ROLE", "Only the purchasing agent or buyer may start an agent run");
      const { text } = parse(z.object({ text: z.string().min(1).max(2000) }), req.body);
      if (!cfg.llm.apiKey)
        throw new ServiceError(503, "LLM_NOT_CONFIGURED", "Configure OPENAI_API_KEY to run the OpenAI + MCP purchasing agent");

      res.status(200).set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      streamStarted = true;
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("status", { stage: "interpret", message: "Interpreting your request…", at: clock.now().toISOString() });

      try {
        const intake = await parseRequestLlm(text, clock.now(), cfg.llm.apiKey, cfg.llm.model);
        send("intake", { intake, at: clock.now().toISOString() });
        if (!intake.complete) {
          send("clarification", { message: intake.question ?? "Please clarify the missing request details.", at: clock.now().toISOString() });
          return res.end();
        }
        await runPurchasingAgent({
          text,
          intake,
          apiKey: cfg.llm.apiKey,
          model: cfg.llm.model,
          agentToken: cfg.tokens.agent,
          onActivity: (activity) => send(activity.type, activity),
        });
        send("done", { at: clock.now().toISOString() });
      } catch (error) {
        send("error", {
          message: error instanceof Error ? error.message : "The purchasing agent failed",
          at: clock.now().toISOString(),
        });
      }
      res.end();
    } catch (error) {
      if (streamStarted) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : "Agent run failed" })}\n\n`);
        res.end();
      } else {
        next(error);
      }
    }
  });

  // ---- agent operations ----
  api.post("/search_products", wrap(async (req) => (optionalReadActor(req, "search"), service.searchProducts(req.body?.request ?? req.body))));
  api.get("/catalog", wrap(async () => service.listCatalog()));
  api.post("/compare_offers", wrap(async (req) => (optionalReadActor(req, "compare"), service.compare(req.body?.request ?? req.body))));
  api.post(
    "/request_order",
    wrap(async (req, res) => {
      const actor = auth(req);
      const body = parse(
        z.object({ request: z.unknown(), option: z.enum(["recommended", "single", "combined"]).optional(), clientRequestId: z.string().max(100).optional() }),
        req.body,
      );
      const out = await service.requestOrder(actor, body);
      res.status(out.outcome === "no_eligible_offer" ? 422 : out.outcome === "submitted" ? 201 : 200);
      return out;
    }),
  );
  api.get("/orders", wrap(async (req) => (auth(req), { orders: service.listOrders() })));
  api.get("/orders/:id", wrap(async (req) => (auth(req), service.outcomeFor(String(req.params.id), "Current status"))));
  api.post("/orders/:id/approve", wrap(async (req) => service.approve(auth(req), String(req.params.id), parse(RevisionRef, req.body))));
  api.post("/orders/:id/reject", wrap(async (req) => service.reject(auth(req), String(req.params.id), parse(RevisionRef, req.body))));
  api.post("/orders/:id/submit", wrap(async (req) => service.submit(auth(req), String(req.params.id), parse(RevisionRef, req.body))));
  api.post("/orders/:id/reconcile", wrap(async (req) => service.reconcile(auth(req), String(req.params.id))));

  // ---- demo controls (local provider only) ----
  const demo = express.Router();
  demo.use((req, _res, next) => {
    if (!cfg.demoMode || !local) return next(new ServiceError(404, "DEMO_DISABLED", "Demo controls are only available with the local provider in demo mode"));
    next();
  });
  demo.post("/reset", (_req, res) => {
    local!.reset();
    service.resetOrders();
    res.json({ ok: true, offers: local!.listOffers() });
  });
  demo.get("/provider", (_req, res) => res.json({ offers: local!.listOffers(), orders: local!.listOrders(), fault: local!.getFault() }));
  demo.post(
    "/set-price",
    wrap(async (req) => {
      const { sku, priceCents } = parse(z.object({ sku: z.string(), priceCents: z.number().int().positive() }), req.body);
      local!.setPrice(sku, priceCents);
      return { ok: true, message: `SKU ${sku} price set to ${formatEur(priceCents)} per pack at the provider`, offers: local!.listOffers() };
    }),
  );
  demo.post(
    "/set-stock",
    wrap(async (req) => {
      const { sku, packs } = parse(z.object({ sku: z.string(), packs: z.number().int().min(0) }), req.body);
      local!.setStock(sku, packs);
      return { ok: true, offers: local!.listOffers() };
    }),
  );
  demo.post(
    "/set-delivery",
    wrap(async (req) => {
      const { sku, deliveryDate } = parse(z.object({ sku: z.string(), deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.body);
      local!.setDeliveryDate(sku, deliveryDate);
      return { ok: true, offers: local!.listOffers() };
    }),
  );
  demo.post(
    "/fault",
    wrap(async (req) => {
      const { mode } = parse(z.object({ mode: z.enum(["none", "timeout_before_commit", "timeout_after_commit"]) }), req.body);
      local!.setFault(mode as LocalFault);
      return { ok: true, fault: mode };
    }),
  );

  app.get("/openapi.json", (_req, res) => res.json(openApiDocument));
  app.use("/api/v1/demo", demo);
  app.use("/api/v1", api);

  if (cfg.staticDir && existsSync(cfg.staticDir)) {
    app.use(express.static(cfg.staticDir));
    app.get(/^\/(?!api|openapi).*/, (_req, res) => res.sendFile(path.resolve(cfg.staticDir!, "index.html")));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ServiceError) return res.status(err.status).json({ error: { code: err.code, message: err.message }, ...err.extra });
    if (err instanceof ValidationError) return res.status(400).json({ error: { code: "VALIDATION_FAILED", message: err.message, issues: err.issues } });
    if ((err as any)?.type === "entity.parse.failed") return res.status(400).json({ error: { code: "INVALID_JSON", message: "Body is not valid JSON" } });
    console.error(err instanceof Error ? err.message : err);
    res.status(500).json({ error: { code: "INTERNAL", message: err instanceof Error ? err.message : "Internal error" } });
  });

  return { app, service, provider, local, db, clock };
}
