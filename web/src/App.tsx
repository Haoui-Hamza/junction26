import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { productIllustration } from "./product-illustration";
import { IngredientBasket, type Basket } from "./IngredientBasket";
import {
  ApiError, call, eur, litres, longDate, signedEur, time,
  type AppConfigView, type CatalogView, type Comparison, type IntakeResult, type OptionLine, type OrderOption, type OrderView, type Outcome, type PurchaseRequest, type RevisionView, type Terms,
} from "./api";

const MAIN_TEXT = "We need 1,000 litres of lactose-free milk delivered by Monday. Find the cheapest option, and combine products if one product doesn't have enough stock.";
const SMALL_TEXT = "Get 100 litres of lactose-free milk delivered by Monday. Keep it under €1,200 if possible.";
const CATALOG_PAGE_SIZE = 12;

interface FormState {
  category: string;
  lactoseFree: boolean;
  organic: boolean;
  vegan: boolean;
  quantity: string;
  latestDeliveryDate: string;
  budgetEur: string;
  budgetIsLimit: boolean;
  requestedSku: string;
}
const emptyForm: FormState = { category: "", lactoseFree: false, organic: false, vegan: false, quantity: "", latestDeliveryDate: "", budgetEur: "", budgetIsLimit: false, requestedSku: "" };
type FlowStage = "searching" | "details" | "offers" | "preparing" | "manager" | "approved" | "placing" | "complete" | "rejected" | "error";

type Banner = { kind: "info" | "error" | "success" | "warn"; text: string } | null;
interface AgentEvent {
  type: string;
  at?: string;
  stage?: string;
  message?: string;
  tool?: string;
  input?: unknown;
  result?: unknown;
  isError?: boolean;
}

export function App() {
  const [cfg, setCfg] = useState<AppConfigView | null>(null);
  const [text, setText] = useState("");
  const [intake, setIntake] = useState<IntakeResult | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [order, setOrder] = useState<OrderView | null>(null);
  const [lastOutcome, setLastOutcome] = useState<Outcome | null>(null);
  const [orders, setOrders] = useState<Array<{ orderId: string; status: string; totalCents: number; revision: number; providerOrderId: string | null; volumeMl: number }>>([]);
  const [catalog, setCatalog] = useState<CatalogView | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogPage, setCatalogPage] = useState(1);
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [providerState, setProviderState] = useState<{ offers: any[]; orders: any[]; fault: string } | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [activity, setActivity] = useState<AgentEvent[]>([]);
  const [flowOpen, setFlowOpen] = useState(false);
  const [basketOpen, setBasketOpen] = useState(false);
  const [selectedBasket, setSelectedBasket] = useState<Basket | null>(null);
  const [basketHints, setBasketHints] = useState<Partial<PurchaseRequest> | null>(null);
  const [baskets, setBaskets] = useState<Basket[]>([]);
  const [flowStage, setFlowStage] = useState<FlowStage>("searching");
  const flowDialog = useRef<HTMLDialogElement>(null);

  const token = useCallback((role: string) => cfg?.demoActors.find((a) => a.role === role)?.token, [cfg]);
  const actorName = (role: string) => cfg?.demoActors.find((a) => a.role === role)?.name ?? role;
  const catalogPageCount = Math.ceil((catalog?.products.length ?? 0) / CATALOG_PAGE_SIZE);
  const visibleCatalogProducts = catalog?.products.slice((catalogPage - 1) * CATALOG_PAGE_SIZE, catalogPage * CATALOG_PAGE_SIZE) ?? [];
  const catalogFirstItem = catalog?.products.length ? (catalogPage - 1) * CATALOG_PAGE_SIZE + 1 : 0;
  const catalogLastItem = Math.min(catalogPage * CATALOG_PAGE_SIZE, catalog?.products.length ?? 0);

  useEffect(() => {
    const dialog = flowDialog.current;
    if (!dialog) return;
    if (flowOpen && !dialog.open) dialog.showModal();
    if (!flowOpen && dialog.open) dialog.close();
  }, [flowOpen]);

  const refreshSide = useCallback(async () => {
    if (!cfg) return;
    const t = token("agent");
    const o = await call<{ orders: typeof orders }>("GET", "/api/v1/orders", t);
    setOrders(o.orders);
    if (cfg.demoMode) setProviderState(await call("GET", "/api/v1/demo/provider"));
  }, [cfg, token]);

  useEffect(() => {
    call<AppConfigView>("GET", "/api/v1/config").then(setCfg).catch((e) => setBanner({ kind: "error", text: `Cannot reach the API: ${e.message}` }));
  }, []);
  useEffect(() => {
    if (!cfg) return;
    call<CatalogView>("GET", "/api/v1/catalog", token("agent"))
      .then((result) => { setCatalog(result); setCatalogPage(1); setCatalogError(null); })
      .catch((e) => setCatalogError(`Could not load products: ${e.message}`));
  }, [cfg, token]);
  useEffect(() => {
    refreshSide().catch(() => undefined);
  }, [refreshSide]);

  const refreshBaskets = useCallback(async () => {
    if (cfg?.providerMode !== "valio" || !token("agent")) return;
    const result = await call<{ baskets: Basket[] }>("GET", "/api/v1/baskets", token("agent"));
    setBaskets(result.baskets);
  }, [cfg, token]);
  useEffect(() => {
    refreshBaskets().catch((e) => setBanner({ kind: "error", text: `Could not load ingredient baskets: ${e.message}` }));
  }, [refreshBaskets]);

  // Keep the open order fresh (changes may come from the MCP adapter or another tab).
  useEffect(() => {
    if (!order || !cfg) return;
    const id = setInterval(async () => {
      try {
        const o = await call<Outcome>("GET", `/api/v1/orders/${order.orderId}`, token("agent"));
        if (o.order && (o.order.status !== order.status || o.order.currentRevision.revision !== order.currentRevision.revision)) {
          setOrder(o.order);
          refreshSide();
        }
      } catch {
        /* ignore */
      }
    }, 2500);
    return () => clearInterval(id);
  }, [order, cfg, token, refreshSide]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    if (["approve", "reject", "submit", "reconcile"].includes(label)) {
      setActivity((items) => [...items, {
        type: "status",
        message: `${actorName("approver")} started ${label === "submit" ? "pre-submission checks" : `${label} action`}.`,
        at: new Date().toISOString(),
      }]);
    }
    try {
      await fn();
    } catch (e) {
      if (flowOpen) setFlowStage("error");
      if (e instanceof ApiError) {
        setBanner({ kind: "error", text: `${e.body?.error?.code ?? "Error"}: ${e.message}` });
        if (e.body?.order) setOrder(e.body.order);
      } else setBanner({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
      if (["approve", "reject", "submit", "reconcile"].includes(label)) {
        setActivity((items) => [...items, {
          type: "status",
          message: `Finished ${label} action. See the order status and decision history for the confirmed result.`,
          at: new Date().toISOString(),
        }]);
      }
      refreshSide().catch(() => undefined);
    }
  };

  const runAgent = () => {
    setFlowOpen(true);
    setFlowStage("searching");
    setBanner(null);
    return run("LLM + MCP agent", async () => {
      setActivity([]);
      setComparison(null);
      setOrder(null);
      let sawComparison = false;
      let needsClarification = false;
      const response = await fetch("/api/v1/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token("agent") ? { Authorization: `Bearer ${token("agent")}` } : {}) },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new ApiError(response.status, body);
      }
      if (!response.body) throw new Error("The agent activity stream is unavailable");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamError: Error | null = null;
      const handleFrame = (frame: string) => {
        const eventName = frame.match(/^event:\s*(.+)$/m)?.[1];
        const data = frame.match(/^data:\s*(.+)$/m)?.[1];
        if (!eventName || !data) return;
        const payload = JSON.parse(data) as AgentEvent & { intake?: IntakeResult };
        const item = { ...payload, type: eventName };
        if (eventName !== "done") setActivity((items) => [...items, item]);
        if (eventName === "intake" && payload.intake) {
          const r = payload.intake;
          setIntake(r);
          setForm({
            category: r.draft.category ?? "",
            lactoseFree: !!r.draft.requiredAttributes?.includes("lactose_free"),
            organic: !!r.draft.requiredAttributes?.includes("organic"),
            vegan: !!r.draft.requiredAttributes?.includes("vegan"),
            quantity: r.draft.quantity ? String(r.draft.quantity) : "",
            latestDeliveryDate: r.draft.latestDeliveryDate ?? "",
            budgetEur: r.draft.preferredBudgetCents ? String(r.draft.preferredBudgetCents / 100) : "",
            budgetIsLimit: !!r.draft.budgetIsLimit,
            requestedSku: r.draft.requestedSku ?? "",
          });
        }
        if (eventName === "clarification") {
          needsClarification = true;
          setBanner({ kind: "warn", text: payload.message ?? "Please clarify your request." });
        }
        if (eventName === "tool_result" && !payload.isError) {
          if (payload.tool === "compare_offers") {
            sawComparison = true;
            setComparison(payload.result as Comparison);
          }
        }
        if (eventName === "error") streamError = new Error(payload.message ?? "The purchasing agent failed");
        if (eventName === "assistant" && payload.message) setBanner({ kind: "info", text: payload.message });
      };

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) handleFrame(frame);
        if (done) break;
      }
      if (buffer.trim()) handleFrame(buffer);
      if (streamError) throw streamError;
      setFlowStage(needsClarification ? "details" : sawComparison ? "offers" : "error");
    });
  };

  const startRequest = async (useAgent: boolean) => {
    setBusy("classify");
    setBanner(null);
    try {
      const result = await call<{ kind: "milk" | "basket"; hints: Partial<PurchaseRequest> }>("POST", "/api/v1/assistant/classify", token("agent"), { text, manual: !useAgent });
      if (result.kind === "basket") {
        setBasketHints(result.hints);
        setSelectedBasket(null);
        setBasketOpen(true);
      } else {
        if (useAgent) await runAgent();
        else await parse();
      }
    } catch (e) {
      setBanner({ kind: "error", text: e instanceof Error ? e.message : "Could not understand the request. Please try again." });
    } finally {
      setBusy(null);
    }
  };

  const formToRequest = (): PurchaseRequest => ({
    rawText: text,
    category: form.category,
    requiredAttributes: [form.lactoseFree && "lactose_free", form.organic && "organic", form.vegan && "vegan"].filter(Boolean) as string[],
    quantity: Number(form.quantity),
    unit: "L",
    latestDeliveryDate: form.latestDeliveryDate,
    preferredBudgetCents: form.budgetEur ? Math.round(Number(form.budgetEur) * 100) : null,
    budgetIsLimit: form.budgetIsLimit,
    requestedSku: form.requestedSku.trim() || null,
  });

  const parse = (t = text) => {
    setFlowOpen(true);
    setFlowStage("details");
    return run("parse", async () => {
      const r = await call<IntakeResult>("POST", "/api/v1/intake/parse", token("agent"), { text: t });
      setIntake(r);
      setComparison(null);
      setForm({
        category: r.draft.category ?? "",
        lactoseFree: !!r.draft.requiredAttributes?.includes("lactose_free"),
        organic: !!r.draft.requiredAttributes?.includes("organic"),
        vegan: !!r.draft.requiredAttributes?.includes("vegan"),
        quantity: r.draft.quantity ? String(r.draft.quantity) : "",
        latestDeliveryDate: r.draft.latestDeliveryDate ?? "",
        budgetEur: r.draft.preferredBudgetCents ? String(r.draft.preferredBudgetCents / 100) : "",
        budgetIsLimit: !!r.draft.budgetIsLimit,
        requestedSku: r.draft.requestedSku ?? "",
      });
      setBanner(r.question ? { kind: "warn", text: r.question } : null);
    });
  };

  const compare = () => {
    setFlowStage("searching");
    setActivity([{ type: "status", stage: "compare", message: "Checking products, prices and delivery dates." }]);
    return run("compare", async () => {
      const c = await call<Comparison>("POST", "/api/v1/compare_offers", token("agent"), { request: formToRequest() });
      setComparison(c);
      setBanner(null);
      setFlowStage("offers");
    });
  };

  const requestOrder = () => {
    setFlowStage("preparing");
    return run("request", async () => {
      const o = await call<Outcome>("POST", "/api/v1/request_order", token("agent"), { request: formToRequest(), option: "recommended" });
      setLastOutcome(o);
      if (o.comparison) setComparison(o.comparison);
      if (o.order) setOrder(o.order);
      if (o.outcome === "submitted") setFlowStage("complete");
      else if (o.outcome === "approval_required") setFlowStage("manager");
      else setFlowStage("error");
      setBanner({ kind: o.outcome === "submitted" ? "success" : o.outcome === "no_eligible_offer" ? "error" : "warn", text: o.message });
    });
  };

  const decide = (action: "approve" | "reject" | "submit", rev: { revision: number; fingerprint: string }, reason?: string) => {
    if (action === "submit") setFlowStage("placing");
    return run(action, async () => {
      if (!order) return;
      const o = await call<Outcome>("POST", `/api/v1/orders/${order.orderId}/${action}`, token("approver"), { ...rev, reason });
      setLastOutcome(o);
      if (o.order) setOrder(o.order);
      if (o.outcome === "approved") setFlowStage("approved");
      else if (o.outcome === "submitted") setFlowStage("complete");
      else if (o.outcome === "rejected") setFlowStage("rejected");
      else if (o.outcome === "requote_required" || o.outcome === "submission_outcome_unknown") setFlowStage("manager");
      setBanner({ kind: o.outcome === "submitted" ? "success" : o.outcome === "requote_required" || o.outcome === "submission_outcome_unknown" ? "warn" : "info", text: `${o.outcome}: ${o.message}` });
    });
  };

  const reconcile = () =>
    run("reconcile", async () => {
      if (!order) return;
      const o = await call<Outcome>("POST", `/api/v1/orders/${order.orderId}/reconcile`, token("approver"));
      if (o.order) setOrder(o.order);
      setFlowStage(o.outcome === "submitted" ? "complete" : "manager");
      setBanner({ kind: "info", text: `${o.outcome}: ${o.message}` });
    });

  const openOrder = (id: string) =>
    run("open", async () => {
      const o = await call<Outcome>("GET", `/api/v1/orders/${id}`, token("agent"));
      setOrder(o.order!);
      setFlowOpen(true);
      setFlowStage(o.order?.status === "submitted" ? "complete" : ["awaiting_approval", "requote_required"].includes(o.order?.status ?? "") ? "manager" : o.order?.status === "approved" ? "approved" : "error");
    });

  const demo = {
    reset: () =>
      run("reset", async () => {
        await call("POST", "/api/v1/demo/reset");
        setOrder(null);
        setComparison(null);
        setLastOutcome(null);
        setBanner({ kind: "info", text: "Local fixtures reset: SKUs A–C are lactose-free dairy milk, D–F are dairy alternatives, and G is vegan oat drink." });
      }),
    scenario: (t: string) => {
      setText(t);
      setOrder(null);
      setLastOutcome(null);
      parse(t);
    },
    priceB: () =>
      run("price", async () => {
        const r = await call<{ message: string }>("POST", "/api/v1/demo/set-price", undefined, { sku: "B", priceCents: 1475 });
        setBanner({ kind: "warn", text: `${r.message}. The approved revision is not touched; the change is detected when the order is revalidated.` });
      }),
    fault: (mode: string) => run("fault", async () => void (await call("POST", "/api/v1/demo/fault", undefined, { mode }))),
  };

  if (!cfg) return <div className="shell"><p>{banner?.text ?? "Loading…"}</p></div>;

  return (
    <div className="shell">
      <header className="market-top">
        <a className="brand" href="#request" aria-label="Valio Aimo kitchen ordering home">
          <img className="brand-logo" src="/valio-aimo-logo.png" alt="Valio Aimo" />
          <span className="brand-caption">Ordering for professional kitchens</span>
        </a>
        <nav className="market-links" aria-label="Main navigation">
          <a className="selected" href="#request">New order</a>
          <a href="#orders" onClick={() => setOrdersOpen(true)}>Orders <span className="count">{orders.length + baskets.length}</span></a>
        </nav>
        <div className="market-account">
          <span className={`badge provider-${cfg.providerMode}`} title={[cfg.provider.description, ...cfg.provider.gaps].join("\n")}>
            <span className="online-dot" /> {cfg.providerMode === "valio" ? cfg.provider.orderMode === "simulated" ? "Live Valio quotes · simulated orders" : "Valio Aimo quotes" : "Sample supplier"}
          </span>
          <span className="account-avatar" title={actorName("buyer")}>{actorName("buyer").slice(0, 1)}</span>
        </div>
      </header>

      {cfg.demoMode && (
        <details className="demo">
          <summary>Sample controls</summary>
          <button onClick={demo.reset} disabled={!!busy}>Reset sample offers</button>
          <button onClick={() => demo.scenario(SMALL_TEXT)} disabled={!!busy}>Load 100 L request</button>
          <button onClick={() => demo.scenario(MAIN_TEXT)} disabled={!!busy}>Load 1,000 L stock-recovery request</button>
          <button onClick={demo.priceB} disabled={!!busy} className="danger-outline">Simulate price change</button>
          <label>
            Simulate supplier issue:{" "}
            <select value={providerState?.fault ?? "none"} onChange={(e) => demo.fault(e.target.value)}>
              <option value="none">No issue</option>
              <option value="timeout_after_commit">Supplier reply delayed after order</option>
              <option value="timeout_before_commit">Supplier unavailable before order</option>
            </select>
          </label>
        </details>
      )}

      {banner && <div className={`banner ${banner.kind}`} onClick={() => setBanner(null)}>{banner.text}</div>}

      <main className="home-view" id="request">
        <section className="card request-card">
          <p className="eyebrow">VALIO AIMO · PROFESSIONAL KITCHENS</p>
          <h1>What does your kitchen need?</h1>
          <p className="home-intro">Write your shopping request in your own words. Aimo will check products, prices and delivery before asking you to continue.</p>
          <label className="visually-hidden" htmlFor="shopping-request">What would you like to order?</label>
          <textarea id="shopping-request" value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="For example: 100 litres of lactose-free milk by Monday, ideally under €500" />
          <div className="row">
            {cfg.llm.enabled && <button className="primary" onClick={() => startRequest(true)} disabled={!!busy || !text.trim()}>{busy === "classify" ? "Understanding your request…" : "Find options with Aimo"} <span aria-hidden="true">→</span></button>}
            <button className={cfg.llm.enabled ? "secondary-action" : "primary"} onClick={() => startRequest(false)} disabled={!!busy || !text.trim()}>{cfg.llm.enabled ? "Review request details" : "Start my order"}</button>
          </div>
          <p className="muted small">
            Your budget and the manager-approval limit are separate. Orders above your stated budget, or above {eur(cfg.policy.autoLimitCents)}, are sent for manager review.
          </p>
        </section>

        <section className="card catalog-card" id="catalog">
          <div className="catalog-heading">
            <div>
              <p className="eyebrow">EXPLORE THE RANGE</p>
              <h2>Available products</h2>
              <p className="muted small">Prices and availability checked for delivery by {longDate(catalog?.checkedFor)}. We’ll confirm them again when you order.</p>
            </div>
            <span className="catalog-heading-icon" aria-hidden="true">✦</span>
          </div>
          <p className="catalog-image-note">Product images are illustrations, not actual packaging.</p>
          {catalogError ? <p className="banner error">{catalogError}</p> : !catalog ? <p className="muted">Loading products…</p> : catalog.products.length === 0 ? (
            <p className="muted">No products are currently available for the selected delivery window.</p>
          ) : (
            <>
              <p className="catalog-count" aria-live="polite">Showing {catalogFirstItem}–{catalogLastItem} of {catalog.products.length} products</p>
              <div className="catalog-grid">
                {visibleCatalogProducts.map((product) => {
                  const illustration = productIllustration(product);
                  return (
                  <article className="catalog-product" key={`${product.category}-${product.sku}`}>
                    <div className={`catalog-visual ${product.category === "plant_milk" ? "plant" : "dairy"}`}>
                      {illustration ? (
                        <img src={illustration} alt="" loading="lazy" />
                      ) : (
                        <span className="catalog-visual-placeholder" aria-hidden="true">{product.category === "plant_milk" ? "Plant-based" : "Dairy"}</span>
                      )}
                      <span className="catalog-category">{product.category === "plant_milk" ? "Plant-based" : "Dairy"}</span>
                    </div>
                    <div className="catalog-product-body">
                      <h3>{product.name}</h3>
                      <p className="catalog-price">{eur(product.priceCents)} <span>/ {product.packVolumeMl ? litres(product.packVolumeMl) : "pack"}</span></p>
                      <div className="catalog-product-meta">
                        <p>{product.stockKnown ? `${product.availablePacks.toLocaleString()} packs available` : "Supplier quantity needs confirmation"}</p>
                        <p>Delivery by {longDate(product.deliveryDate)}</p>
                      </div>
                    </div>
                  </article>
                  );
                })}
              </div>
              {catalogPageCount > 1 && (
                <nav className="catalog-pagination" aria-label="Available product pages">
                  <button type="button" onClick={() => setCatalogPage((page) => page - 1)} disabled={catalogPage === 1}>Previous</button>
                  <span aria-current="page">Page {catalogPage} of {catalogPageCount}</span>
                  <button type="button" onClick={() => setCatalogPage((page) => page + 1)} disabled={catalogPage === catalogPageCount}>Next</button>
                </nav>
              )}
            </>
          )}
        </section>

        <details className="card orders-card" id="orders" open={ordersOpen} onToggle={(event) => setOrdersOpen(event.currentTarget.open)}>
          <summary>Recent orders ({orders.length + baskets.length})</summary>
          {orders.length === 0 && baskets.length === 0 ? <p className="muted">Your orders will appear here.</p> : orders.length > 0 && (
            <table className="small">
              <thead><tr><th>Order</th><th>Status</th><th>Amount</th><th>Total</th></tr></thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.orderId} onClick={() => openOrder(o.orderId)} className="click">
                    <td>{o.orderId}</td><td><Status s={o.status} /></td><td>{litres(o.volumeMl)}</td><td>{eur(o.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {baskets.length > 0 && <div className="basket-history"><h3>Ingredient baskets</h3>{baskets.map((item) => <button key={item.id} onClick={() => { setSelectedBasket(item); setBasketHints(null); setBasketOpen(true); }}>{item.id} · {item.details.input.description} · {eur(item.details.totalCents)} · {item.status.replaceAll("_", " ")}</button>)}</div>}
        </details>
      </main>

      {basketOpen && <IngredientBasket text={text} today={cfg.clock.today} agentToken={token("agent")} approverToken={token("approver")} llmEnabled={cfg.llm.enabled} existing={selectedBasket} hints={basketHints} onClose={() => setBasketOpen(false)} onChanged={() => { refreshBaskets().catch((e) => setBanner({ kind: "error", text: `Could not refresh ingredient baskets: ${e.message}` })); }} />}

      <dialog
        ref={flowDialog}
        className="flow-dialog"
        aria-labelledby="flow-title"
        onCancel={(event) => { event.preventDefault(); setFlowOpen(false); }}
      >
        <div className="flow-dialog-head">
          <div>
            <p className="eyebrow">YOUR ORDER · {flowStepLabel(flowStage)}</p>
            <h2 id="flow-title">{flowTitle(flowStage)}</h2>
          </div>
          <button className="close-flow" onClick={() => setFlowOpen(false)} aria-label="Close order steps" disabled={!!busy}>×</button>
        </div>

        {flowStage === "searching" && (
          <div className="flow-progress" aria-live="polite">
            <span className="loading-spinner" aria-hidden="true" />
            <h3>{busy === "LLM + MCP agent" ? "Aimo is checking your request" : "Checking products and delivery"}</h3>
            <p>We’re matching your needs with suitable products and current offers. No order will be placed until you continue.</p>
            <ol>
              {activity.filter((item) => item.type === "status" || item.type === "tool_call" || item.type === "tool_result").map((item, index) => (
                <li key={`${item.at ?? "event"}-${index}`} className={item.type === "tool_result" && !item.isError ? "complete" : ""}>
                  <span aria-hidden="true">{item.type === "tool_result" && !item.isError ? "✓" : "•"}</span>{activityLabel(item)}
                </li>
              ))}
            </ol>
          </div>
        )}

        {flowStage === "details" && (
          <section className="flow-stage">
            {banner?.kind === "warn" && <div className="banner warn">{banner.text}</div>}
            {intake && (
              <>
                <div className="request-summary">
                  <b>Please check what we understood</b>
                  <span>{form.quantity || "?"} litres of {form.category === "plant_milk" ? "plant-based milk" : form.category === "milk" ? "dairy milk" : "an unspecified product"}</span>
                  {form.latestDeliveryDate && <span>Needed by {longDate(form.latestDeliveryDate)}</span>}
                  {form.budgetEur && <span>{form.budgetIsLimit ? "Budget limit" : "Target budget"}: €{form.budgetEur}</span>}
                </div>
                <div className="fields flow-fields">
                  <label>Product
                    <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value, vegan: e.target.value === "plant_milk" || form.vegan })}>
                      <option value="">Select a supported product</option>
                      <option value="milk">Dairy milk</option>
                      <option value="plant_milk">Plant-based milk</option>
                    </select>
                  </label>
                  <label>Quantity (litres)
                    <input type="number" min={1} value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
                  </label>
                  <label>Latest delivery date
                    <input type="date" value={form.latestDeliveryDate} onChange={(e) => setForm({ ...form, latestDeliveryDate: e.target.value })} />
                  </label>
                  <label>Budget (€)
                    <input type="number" min={0} value={form.budgetEur} onChange={(e) => setForm({ ...form, budgetEur: e.target.value })} placeholder="Optional" />
                  </label>
                  <fieldset className="preference-field">
                    <legend>Product requirements</legend>
                    <span className="checks">
                      <label><input type="checkbox" checked={form.lactoseFree} onChange={(e) => setForm({ ...form, lactoseFree: e.target.checked })} /> Lactose-free</label>
                      <label><input type="checkbox" checked={form.organic} onChange={(e) => setForm({ ...form, organic: e.target.checked })} /> Organic</label>
                      <label><input type="checkbox" checked={form.vegan} onChange={(e) => setForm({ ...form, vegan: e.target.checked })} /> Vegan</label>
                    </span>
                  </fieldset>
                </div>
                {Number(form.budgetEur) > 0 && (
                  <label className="budget-limit-choice">
                    <input type="checkbox" checked={form.budgetIsLimit} onChange={(e) => setForm({ ...form, budgetIsLimit: e.target.checked })} />
                    Do not go over this budget without a manager’s approval
                  </label>
                )}
                <details className="advanced-details">
                  <summary>Specific product code (optional)</summary>
                  <label>Product code
                    <input value={form.requestedSku} onChange={(e) => setForm({ ...form, requestedSku: e.target.value })} />
                  </label>
                </details>
                {intake.notes.length > 0 && <ul className="notes">{intake.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
                <div className="row flow-actions">
                  <button onClick={() => setFlowOpen(false)}>Change my request</button>
                  <button className="primary" onClick={compare} disabled={!!busy || !form.category || !form.quantity || !form.latestDeliveryDate}>Find matching options</button>
                </div>
              </>
            )}
          </section>
        )}

        {flowStage === "offers" && comparison && (
          <ComparisonView
            c={comparison}
            busy={!!busy}
            allowOrder={cfg.provider.orderMode === "simulated" && !!token("agent")}
            onPrepare={requestOrder}
            onRevise={(ml) => {
              setForm({ ...form, quantity: String(ml / 1000) });
              setComparison(null);
              setFlowStage("details");
              setBanner({ kind: "info", text: `Request revised to ${litres(ml)}. Check the amount and find options again.` });
            }}
          />
        )}

        {(flowStage === "preparing" || flowStage === "placing") && (
          <div className="flow-progress" aria-live="polite">
            <span className="loading-spinner" aria-hidden="true" />
            <h3>{flowStage === "placing" ? "Processing your order" : "Preparing your order"}</h3>
            <p>{flowStage === "placing" ? cfg.provider.orderMode === "simulated" ? "Rechecking the live quote, then recording it locally. Nothing is sent to Valio." : "Checking the final price and sending the order to the supplier." : "Checking the latest price and whether manager approval is needed."}</p>
          </div>
        )}

        {(flowStage === "manager" || flowStage === "approved") && order && (
          <div className="flow-stage">
            {flowStage === "approved" && <div className="banner success">Approved. Place the order when you’re ready.</div>}
            <OrderPanel order={order} cfg={cfg} busy={!!busy} approverName={actorName("approver")} onDecide={decide} onReconcile={reconcile} />
          </div>
        )}

        {flowStage === "complete" && order && (
          <section className="flow-complete" role="status">
            <span className="complete-mark" aria-hidden="true">✓</span>
            <h3>{cfg.provider.orderMode === "simulated" ? "Order recorded successfully" : "Your order is placed"}</h3>
            <p>{litres(order.currentRevision.terms.volumeMl)} · {eur(order.currentRevision.terms.totalCents)} · delivery by {longDate(order.currentRevision.terms.latestDeliveryDate)}</p>
            <p className="muted">{cfg.provider.orderMode === "simulated" ? "Simulation only — no order was sent to Valio. Reference:" : "Supplier confirmation:"} <b>{order.providerOrderId ?? "received"}</b></p>
            <button className="primary" onClick={() => setFlowOpen(false)}>Done</button>
          </section>
        )}

        {flowStage === "rejected" && (
          <section className="flow-complete">
            <h3>Order not placed</h3>
            <p>The manager declined this order. You can change the request and try again.</p>
            <button className="primary" onClick={() => { setFlowStage("details"); setOrder(null); }}>Edit request</button>
          </section>
        )}

        {flowStage === "error" && (
          <section className="flow-stage">
            <div className="banner error">{banner?.text ?? lastOutcome?.message ?? "We couldn’t complete this step. Please check the request and try again."}</div>
            {comparison?.noFill && <p>{comparison.noFill.message}</p>}
            <div className="row flow-actions">
              <button onClick={() => setFlowOpen(false)}>Close</button>
              {intake && <button className="primary" onClick={() => setFlowStage("details")}>Check request details</button>}
            </div>
          </section>
        )}
      </dialog>
    </div>
  );
}

function Status({ s }: { s: string }) {
  const labels: Record<string, string> = {
    awaiting_approval: "Needs manager approval",
    requote_required: "Price changed — review again",
    submission_unknown: "Checking order status",
    submitted: "Completed",
    approved: "Approved",
    rejected: "Declined",
    returned_to_buyer: "Needs changes",
  };
  return <span className={`status st-${s}`}>{labels[s] ?? s.replaceAll("_", " ")}</span>;
}

function activityLabel(item: AgentEvent) {
  const labels: Record<string, string> = {
    search_products: "Checking available products",
    compare_offers: "Comparing prices and delivery",
    request_order: "Preparing your order",
    get_order_status: "Checking order status",
  };
  if (item.type === "tool_call") return labels[item.tool ?? ""] ?? "Working on your request";
  if (item.type === "tool_result") return item.isError ? "Could not complete this step" : "Step complete";
  if (item.type === "assistant") return "Aimo’s update";
  if (item.type === "intake") return "Understanding your shopping list";
  if (item.type === "clarification") return "Aimo needs one more detail";
  if (item.type === "status") {
    const stages: Record<string, string> = {
      interpret: "Understanding your request",
      mcp_connect: "Preparing the product search",
      agent: "Finding matching products",
      compare: "Comparing prices and delivery",
    };
    return stages[item.stage ?? ""] ?? item.message ?? "Checking your request";
  }
  return item.stage ?? "Shopping progress";
}

function flowTitle(stage: FlowStage) {
  const titles: Record<FlowStage, string> = {
    searching: "Finding your best options",
    details: "Check your order details",
    offers: "Review the best option",
    preparing: "Checking the order",
    manager: "Manager review",
    approved: "Ready to place the order",
    placing: "Placing your order",
    complete: "Order confirmed",
    rejected: "Order not placed",
    error: "We need to check something",
  };
  return titles[stage];
}

function flowStepLabel(stage: FlowStage) {
  if (stage === "searching") return "Step 1 of 3 · finding options";
  if (stage === "details") return "Check your request";
  if (stage === "offers" || stage === "preparing") return "Step 2 of 3 · review";
  if (stage === "manager" || stage === "approved" || stage === "placing") return "Step 3 of 3 · approval and order";
  if (stage === "complete") return "Complete";
  return "Update";
}

function LinesTable({ lines, highlight }: { lines: OptionLine[]; highlight?: (l: OptionLine, field: string) => boolean }) {
  const hl = (l: OptionLine, f: string) => (highlight?.(l, f) ? "changed" : "");
  return (
    <table className="lines">
      <thead><tr><th>SKU</th><th>Packs</th><th>Litres</th><th>€/pack</th><th>Line</th><th>Delivery</th></tr></thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.sku} title={l.name}>
            <td className={hl(l, "sku")}><b>{l.sku}</b> <span className="muted">{l.name}</span></td>
            <td className={hl(l, "packs")}>{l.packs}</td>
            <td>{litres(l.volumeMl)}</td>
            <td className={hl(l, "unit_price")}>{eur(l.unitPriceCents)}</td>
            <td className={hl(l, "line_total")}>{eur(l.lineTotalCents)}</td>
            <td className={hl(l, "delivery_date")}>{longDate(l.deliveryDate)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OptionCard({ title, opt, recommended, extra }: { title: string; opt: OrderOption | null; recommended: boolean; extra?: React.ReactNode }) {
  return (
    <div className={`option ${recommended ? "rec" : ""}`}>
      <div className="opthead">
        <h3>{title}</h3>
        {recommended && <span className="tag">Recommended</span>}
      </div>
      {opt ? (
        <>
          <ul className="offer-lines">
            {opt.lines.map((line) => (
              <li key={line.sku}>
                <span>{line.name}</span>
                <span>{litres(line.volumeMl)}</span>
                <b>{eur(line.lineTotalCents)}</b>
              </li>
            ))}
          </ul>
          <div className="total">
            <span>{litres(opt.volumeMl)} · delivery by {longDate(opt.latestDeliveryDate)}</span>
            <b>{eur(opt.totalCents)}</b>
          </div>
          {extra}
          <details className="product-details">
            <summary>See product and pack details</summary>
            <LinesTable lines={opt.lines} />
          </details>
        </>
      ) : (
        <p className="muted">No option of this kind fulfils the request exactly.</p>
      )}
    </div>
  );
}

function ComparisonView({ c, busy, allowOrder, onPrepare, onRevise }: { c: Comparison; busy: boolean; allowOrder: boolean; onPrepare: () => void; onRevise: (ml: number) => void }) {
  const qtyMl = Math.round(c.request.quantity * 1000);
  const combined = c.combined && c.combined.lines.length > 1 ? c.combined : null;
  const recommended = c.recommendedKind === "combined" ? combined ?? c.single : c.single;
  const alternative = c.recommendedKind === "combined" ? c.single : combined;
  const budgetExceeded = !!recommended && !!c.request.budgetIsLimit && c.request.preferredBudgetCents != null && recommended.totalCents > c.request.preferredBudgetCents;
  return (
    <section className="card">
      <h2><span className="step">2</span> {c.searchBounded ? "Option found" : "Best option found"}</h2>
      <div className="keyfacts">
        <span>{litres(qtyMl)}</span>
        <span>Needed by {longDate(c.request.latestDeliveryDate)}</span>
        {c.request.requiredAttributes.map((attribute) => <span key={attribute}>{attribute.replaceAll("_", " ")}</span>)}
      </div>
      {c.savingsCents ? (
        <div className="savings">
          This option saves <b>{eur(c.savingsCents)}</b> compared with ordering from one product.
        </div>
      ) : null}
      {budgetExceeded && c.request.preferredBudgetCents != null && recommended && (
        <div className="banner warn budget-warning">
          This option is {eur(recommended.totalCents - c.request.preferredBudgetCents)} over your {eur(c.request.preferredBudgetCents)} budget limit. It will not be ordered automatically; a manager must approve the exception.
        </div>
      )}
      <div className="options">
        <OptionCard title={c.searchBounded ? "Available match" : "Best match"} opt={recommended} recommended={true} />
      </div>
      {alternative && (
        <details className="alternative-option">
          <summary>See another option</summary>
          <OptionCard title="Another suitable option" opt={alternative} recommended={false} />
        </details>
      )}
      {c.notes.length > 0 && <ul className="notes">{c.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      {c.noFill && (
        <div className="nofill">
          <b>{c.noFill.code === "SEARCH_LIMIT_REACHED" ? "The comparison is incomplete." : "We couldn’t find an exact match."}</b> {c.noFill.message}
          {c.partialOptions.map((p) => (
            <div key={p.kind} className="partial">
              <div className="opthead">
                <h3>{p.kind === "partial_shortfall" ? "A smaller amount is available" : "The closest available amount"}</h3>
              </div>
              <LinesTable lines={p.lines} />
              <div className="total"><span>{litres(p.volumeMl)}</span><b>{eur(p.totalCents)}</b></div>
              <button onClick={() => onRevise(p.volumeMl)}>Change request to {litres(p.volumeMl)}</button>
            </div>
          ))}
        </div>
      )}
      {recommended && (
        <div className="continue-order">
          {allowOrder ? (
            <>
              <p>{budgetExceeded ? "You can ask a manager to review this over-budget option. Nothing is recorded before the review." : "Continue to the simulated order. Nothing will be sent to the supplier."}</p>
              <button className="primary" onClick={onPrepare} disabled={busy}>{budgetExceeded ? "Ask manager to review" : "Continue to order"}</button>
            </>
          ) : (
            <p className="muted">These are current supplier quotes for comparison only. Ordering is not available in this supplier setup.</p>
          )}
        </div>
      )}
      {c.excluded.length > 0 && (
        <details>
          <summary>Why other products weren’t shown</summary>
          <ul className="excluded">
            {c.excluded.slice(0, 50).map((e) => (
              <li key={e.sku}>{e.name}: {e.reasons.map((r) => r.message).join("; ")}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function TermsSummary({ t }: { t: Terms }) {
  return (
    <div className="total">
      <span>{litres(t.volumeMl)} · {t.currency} · delivery by {longDate(t.latestDeliveryDate)} (deadline {longDate(t.deliveryDeadline)})</span>
      <b>{eur(t.totalCents)}</b>
    </div>
  );
}

function DiffView({ prev, cur, approvedPrev }: { prev: RevisionView; cur: RevisionView; approvedPrev: boolean }) {
  const diff = cur.diff!;
  const changedSku = (sku: string, field: string) => diff.changes.some((c) => c.sku === sku && (c.field === field || c.field === "sku_added" || c.field === "sku_removed"));
  return (
    <div className="diff">
      <div className={`delta ${diff.totalDeltaCents > 0 ? "up" : "down"}`}>
        Total {eur(prev.terms.totalCents)} → {eur(cur.terms.totalCents)} <b>{signedEur(diff.totalDeltaCents)}</b>
      </div>
      <p className="reason">{cur.changeReason}</p>
      <div className="sidebyside">
        <div className="old">
          <h4>Revision {prev.revision} {approvedPrev ? "(approved snapshot — now stale)" : "(previous)"}</h4>
          <LinesTable lines={prev.terms.lines} highlight={(l, f) => changedSku(l.sku, f)} />
          <TermsSummary t={prev.terms} />
          <p className="mono small">fingerprint {prev.fingerprint.slice(0, 16)}…</p>
        </div>
        <div className="new">
          <h4>Revision {cur.revision} (needs a fresh decision)</h4>
          <LinesTable lines={cur.terms.lines} highlight={(l, f) => changedSku(l.sku, f)} />
          <TermsSummary t={cur.terms} />
          <p className="mono small">fingerprint {cur.fingerprint.slice(0, 16)}…</p>
        </div>
      </div>
      <ul className="changes">{diff.changes.map((c, i) => <li key={i}>{c.message}</li>)}</ul>
    </div>
  );
}

function OrderPanel({ order, cfg, busy, approverName, onDecide, onReconcile }: {
  order: OrderView; cfg: AppConfigView; busy: boolean; approverName: string;
  onDecide: (a: "approve" | "reject" | "submit", rev: { revision: number; fingerprint: string }, reason?: string) => void;
  onReconcile: () => void;
}) {
  const cur = order.currentRevision;
  const prev = order.revisions.find((r) => r.revision === cur.revision - 1);
  const ref = { revision: cur.revision, fingerprint: cur.fingerprint };
  const canDecide = ["awaiting_approval", "requote_required"].includes(order.status);
  const approvedPrev = !!prev && order.approvals.some((a) => a.revision === prev.revision && a.decision === "approved");
  const extraNotes = useMemo(() => order.events.filter((e) => e.action === "replacement_proposed").slice(-1), [order.events]);
  const over = cur.terms.totalCents - order.policy.autoLimitCents;
  const overBudget = !!order.request.budgetIsLimit && order.request.preferredBudgetCents != null && cur.terms.totalCents > order.request.preferredBudgetCents;
  return (
    <>
      <section className="card">
        <h2><span className="step">3</span> Manager review</h2>
        <div className="orderhead">
          <Status s={order.status} />
          <span><b>{eur(cur.terms.totalCents)}</b> · {litres(cur.terms.volumeMl)}</span>
          <span>Delivery by {longDate(cur.terms.latestDeliveryDate)}</span>
        </div>
        {order.statusReason && <p className="reason">{order.statusReason}</p>}

        <div className="limit">
          <div>This order <b>{eur(cur.terms.totalCents)}</b></div>
          <div className={over > 0 || overBudget ? "over" : "under"}>
            {over > 0 || overBudget ? `Manager approval needed` : `Within the automatic limit`}
          </div>
        </div>
        {cur.policy.reasons.length > 0 && (
          <ul className="approvalwhy">
            <li><b>Why this needs your review</b></li>
            {cur.policy.reasons.map((r) => <li key={r.code}>{r.message}</li>)}
            {cur.revision > 1 && <li>The order details changed, so the earlier approval no longer applies.</li>}
          </ul>
        )}
        {cur.policy.notes.map((n) => <p key={n} className="muted small">{n}</p>)}

        {prev && cur.diff ? <DiffView prev={prev} cur={cur} approvedPrev={approvedPrev} /> : (
          <>
            <LinesTable lines={cur.terms.lines} />
            <TermsSummary t={cur.terms} />
          </>
        )}
        {extraNotes.map((e) => <p key={e.id} className="muted small">{e.reason}</p>)}

        <div className="row actions">
          {canDecide && (
            <>
              <button className="primary" disabled={busy} onClick={() => onDecide("approve", ref)}>Approve order · {eur(cur.terms.totalCents)}</button>
              <button className="danger-outline" disabled={busy} onClick={() => { const r = prompt("Reason for rejection?") ?? undefined; onDecide("reject", ref, r); }}>Reject</button>
            </>
          )}
          {order.status === "approved" && (
            <button className="primary" disabled={busy} onClick={() => onDecide("submit", ref)}>Place order</button>
          )}
          {order.status === "submission_unknown" && <button className="primary" disabled={busy} onClick={onReconcile}>Check whether it was placed</button>}
        </div>
        {order.provider.orderMode === "simulated" && <p className="banner warn">Simulation only. This will not send an order to Valio.</p>}
        <details className="technical-order-details">
          <summary>Order reference and more information</summary>
          <p>Order reference: <span className="mono">{order.orderId}</span> · revision {cur.revision} · supplier: {order.provider.label} · reviewer: {approverName}</p>
          <p className="mono small">Offer reference: {cur.fingerprint}</p>
          {prev && canDecide && <button className="ghost" disabled={busy} onClick={() => onDecide("approve", { revision: prev.revision, fingerprint: prev.fingerprint })}>Test approval from an older page</button>}
        </details>
      </section>

      {order.status === "submitted" && (
        <section className="card confirm" role="status">
          <h2>{order.provider.orderMode === "simulated" ? "Order recorded successfully" : "Order placed"}</h2>
          <p>{litres(cur.terms.volumeMl)} · {eur(cur.terms.totalCents)} · delivery by {longDate(cur.terms.latestDeliveryDate)}</p>
          {order.provider.orderMode === "simulated" && <p className="muted small">Simulation only — no order was sent to Valio.</p>}
          <details>
            <summary>{order.provider.orderMode === "simulated" ? "Simulation reference details" : "Supplier confirmation details"}</summary>
            <p className="mono">{order.providerOrderId}</p>
            <p className="muted small">Submission records: {order.submissions.map((s) => `revision ${s.revision}: ${s.status}${s.providerOrderId ? ` (${s.providerOrderId})` : ""}`).join(" · ")}</p>
          </details>
        </section>
      )}

      <details className="card decision-history">
        <summary>Order history</summary>
        <table className="small history">
          <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Version</th><th>Reason</th></tr></thead>
          <tbody>
            {order.events.map((e) => (
              <tr key={e.id} className={`ev-${e.action}`}>
                <td className="mono">{time(e.at)}</td><td>{e.actorName}</td><td><code>{e.action}</code></td><td>{e.revision ?? ""}</td><td>{e.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">Clock: {cfg.clock.fixed ? "fixed sample clock (advances from start time)" : "system"} · Europe/Helsinki</p>
      </details>
    </>
  );
}
