import { useEffect, useRef, useState } from "react";
import { call, eur, longDate, type PurchaseRequest } from "./api";

interface Product {
  sku: string; name: string; priceCents: number; availablePacks: number; stockKnown: boolean;
  deliveryDate: string; packWeightG: number | null;
}
interface Row { id: number; ingredient: string; grams: string; searchQuery: string; products: Product[]; selected: string; packs: string; searched: boolean; reason: string }
const emptyRow = (id: number): Row => ({ id, ingredient: "", grams: "", searchQuery: "", products: [], selected: "", packs: "1", searched: false, reason: "" });
interface BasketInput {
  description: string; deliveryDate: string; dietaryNotes: string; budgetCents: number | null; budgetIsLimit: boolean;
  lines: Array<{ ingredient: string; sku: string; packs: number; requiredGrams?: number }>;
}
interface BasketDetails {
  input: BasketInput;
  lines: Array<{ ingredient: string; sku: string; name: string; packs: number; priceCents: number; lineTotalCents: number; deliveryDate: string; stockKnown: boolean; packWeightG: number | null }>;
  totalCents: number; approvalReasons: string[];
}
export interface Basket { id: string; status: string; details: BasketDetails; fingerprint: string; providerOrderId: string | null; approvedBy: string | null }
interface Preview { details: BasketDetails; fingerprint: string }
interface Recommendation { ingredient: { name: string; grams: number }; product: (Product & { packs: number }) | null; reason: string }

export function IngredientBasket({ text, today, agentToken, approverToken, llmEnabled, existing, hints, onClose, onChanged }: {
  text: string; today: string; agentToken?: string; approverToken?: string; llmEnabled: boolean;
  existing: Basket | null; hints: Partial<PurchaseRequest> | null; onClose: () => void; onChanged: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [deliveryDate, setDeliveryDate] = useState(existing?.details.input.deliveryDate ?? hints?.latestDeliveryDate ?? "");
  const [servings, setServings] = useState(text.match(/\b(?:for\s+)?(\d+)\s*(?:people|persons?|servings?|portions?)\b/i)?.[1] ?? "");
  const [dietaryNotes, setDietaryNotes] = useState(existing?.details.input.dietaryNotes ?? "");
  const [budget, setBudget] = useState(existing?.details.input.budgetCents ? String(existing.details.input.budgetCents / 100) : hints?.preferredBudgetCents ? String(hints.preferredBudgetCents / 100) : "");
  const [budgetIsLimit, setBudgetIsLimit] = useState(existing?.details.input.budgetIsLimit ?? hints?.budgetIsLimit ?? true);
  const [rows, setRows] = useState<Row[]>([emptyRow(1)]);
  const [nextId, setNextId] = useState(2);
  const [stage, setStage] = useState<"details" | "ingredients" | "products" | "review" | "order">(existing ? "order" : "details");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [basket, setBasket] = useState<Basket | null>(existing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [explanation, setExplanation] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [confirmedIngredients, setConfirmedIngredients] = useState(false);
  const [suggestionAttempted, setSuggestionAttempted] = useState(false);
  const [query, setQuery] = useState(text);

  useEffect(() => { dialog.current?.showModal(); }, []);
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "The request failed."); } finally { setBusy(false); }
  };
  const updateRow = (id: number, patch: Partial<Row>) => setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  const invalidateSuggestions = () => {
    setSuggestionAttempted(false); setConfirmedIngredients(false); setExplanation("");
    setRows([emptyRow(1)]); setNextId(2);
  };
  const suggest = () => perform(async () => {
    const result = await call<{ ingredients: Array<{ name: string; grams: number }>; explanation: string }>("POST", "/api/v1/baskets/suggest", agentToken, {
      text: `${query}\n${servings ? `Servings: ${servings}.` : ""}\n${dietaryNotes ? `Dietary requirements: ${dietaryNotes}.` : ""}`,
      servings: Number(servings),
    });
    setExplanation(result.explanation);
    setSuggestionAttempted(true);
    setRows(result.ingredients.length ? result.ingredients.map((ingredient, index) => ({ ...emptyRow(index + 1), ingredient: ingredient.name, searchQuery: ingredient.name, grams: String(Math.max(1, Math.round(ingredient.grams))) })) : [emptyRow(1)]);
    setNextId(Math.max(2, result.ingredients.length + 1));
    setConfirmedIngredients(false);
  });
  const search = (row: Row) => perform(async () => {
    const result = await call<{ products: Product[] }>("POST", "/api/v1/baskets/search", agentToken, { query: row.searchQuery.trim() || row.ingredient, deliveryDate });
    updateRow(row.id, { products: result.products, selected: "", searched: true, reason: "" });
  });
  const buildInput = (): BasketInput => ({
    description: query, deliveryDate, dietaryNotes, budgetCents: budget ? Math.round(Number(budget) * 100) : null, budgetIsLimit,
    lines: rows.map((row) => ({ ingredient: row.ingredient, sku: row.selected, packs: Number(row.packs), requiredGrams: Number(row.grams) })),
  });
  const review = () => perform(async () => {
    const result = await call<Preview>("POST", "/api/v1/baskets/preview", agentToken, buildInput());
    setPreview(result); setConfirmed(false); setStage("review");
  });
  const recommend = () => perform(async () => {
    const result = await call<{ recommendations: Recommendation[] }>("POST", "/api/v1/baskets/recommend", agentToken, {
      deliveryDate, dietaryNotes, ingredients: rows.map((row) => ({ name: row.ingredient, grams: Number(row.grams) })),
    });
    const updated = rows.map((row, index) => {
      const rec = result.recommendations[index];
      return { ...row, products: rec.product ? [rec.product] : [], selected: rec.product?.sku ?? "", packs: String(rec.product?.packs ?? 1), searched: true, reason: rec.reason };
    });
    setRows(updated);
    setStage("products");
    if (updated.some((row) => !row.selected)) setError("Some ingredients need your help. Search for a suitable product or change the ingredient.");
  });
  const create = () => perform(async () => {
    if (!preview) return;
    const result = await call<Basket>("POST", "/api/v1/baskets", agentToken, { input: preview.details.input, fingerprint: preview.fingerprint });
    setBasket(result); setStage("order"); onChanged();
  });
  const action = (name: "approve" | "reject" | "submit") => perform(async () => {
    if (!basket) return;
    const result = await call<Basket>("POST", `/api/v1/baskets/${basket.id}/${name}`, name === "submit" ? agentToken : approverToken, { fingerprint: basket.fingerprint });
    setBasket(result); onChanged();
  });
  const validIngredients = rows.length > 0 && rows.every((r) => r.ingredient.trim() && Number.isInteger(Number(r.grams)) && Number(r.grams) > 0);
  const validRows = validIngredients && rows.every((r) => r.selected && Number.isInteger(Number(r.packs)) && Number(r.packs) > 0);

  return (
    <dialog ref={dialog} className="flow-dialog basket-dialog" aria-labelledby="basket-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <div className="flow-dialog-head"><div><p className="eyebrow">YOUR INGREDIENT BASKET</p><h2 id="basket-title">{stage === "details" ? "Tell us what you need" : stage === "ingredients" ? "Approve your essentials" : stage === "products" ? "Products selected for you" : stage === "review" ? "Review your basket" : "Basket status"}</h2></div><button className="close-flow" onClick={onClose} disabled={busy} aria-label="Close basket">×</button></div>
      {error && <div className="banner error" role="alert">{error}</div>}
      {stage === "details" && (
        <section className="card">
          <p>Tell us the number of servings and we’ll suggest essential ingredients and estimated amounts. After you approve them, we’ll find products for your review.</p>
          <div className="fields flow-fields">
            <label className="preference-field">Meal or products needed<textarea value={query} onChange={(e) => { setQuery(e.target.value); invalidateSuggestions(); }} rows={2} /></label>
            <label>How many servings?<input type="number" min="1" max="100000" step="1" value={servings} onChange={(e) => { setServings(e.target.value); invalidateSuggestions(); }} placeholder="For example, 50" /></label>
            <label>Latest delivery date<input type="date" min={today} value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} /></label>
            <label>Budget in euros (optional)<input type="number" min="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} /></label>
            <label>Dietary needs or allergies (optional)<input value={dietaryNotes} onChange={(e) => { setDietaryNotes(e.target.value); invalidateSuggestions(); }} placeholder="For example, gluten-free" /></label>
          </div>
          {budget && <label className="budget-limit-choice"><input type="checkbox" checked={budgetIsLimit} onChange={(e) => setBudgetIsLimit(e.target.checked)} /> Require manager approval if this budget is exceeded</label>}
          <p className="muted small">Dietary notes are shown for your review. Product labels and allergens are not automatically verified; check them before continuing.</p>
          <div className="row flow-actions"><button className="primary" disabled={busy || !query.trim() || !Number.isInteger(Number(servings)) || Number(servings) < 1 || Number(servings) > 100000 || !deliveryDate || deliveryDate < today || (!!budget && Number(budget) <= 0)} onClick={() => { setStage("ingredients"); if (llmEnabled && !suggestionAttempted) suggest(); }}>Continue to ingredients</button></div>
        </section>
      )}
      {stage === "ingredients" && (
        <section className="card">
          <p>Review the essentials and estimated quantities for {servings} servings. Add, remove or change anything before Aimo finds products.</p>
          <p className="muted small">Amounts are estimates, not a recipe guarantee. Check them against your kitchen’s recipe and needs.</p>
          {dietaryNotes && <p className="banner warn">Your requirements: {dietaryNotes}. Verify each product’s label; these requirements are not automatically enforced.</p>}
          {llmEnabled && <button onClick={suggest} disabled={busy}>{busy ? "Working…" : "Suggest ingredients with Aimo"}</button>}
          {explanation && <p className="muted">{explanation}</p>}
          <div className="basket-ingredients">
            {rows.map((row) => (
              <div className="basket-ingredient" key={row.id}>
                <div className="basket-search"><label>Ingredient<input disabled={busy} value={row.ingredient} onChange={(e) => { updateRow(row.id, { ingredient: e.target.value, searchQuery: e.target.value, products: [], selected: "", searched: false, reason: "" }); setConfirmedIngredients(false); }} placeholder="For example, spaghetti" /></label>
                  <label>Estimated amount (grams)<input disabled={busy} type="number" min="1" step="1" value={row.grams} onChange={(e) => { updateRow(row.id, { grams: e.target.value, selected: "", reason: "" }); setConfirmedIngredients(false); }} /></label>
                  <button disabled={busy || rows.length === 1} onClick={() => { setRows(rows.filter((r) => r.id !== row.id)); setConfirmedIngredients(false); }}>Remove</button></div>
              </div>
            ))}
          </div>
          <button onClick={() => { setRows([...rows, emptyRow(nextId)]); setNextId(nextId + 1); setConfirmedIngredients(false); }} disabled={busy || rows.length >= 12}>+ Add ingredient</button>
          <label className="budget-limit-choice"><input type="checkbox" disabled={busy} checked={confirmedIngredients} onChange={(e) => setConfirmedIngredients(e.target.checked)} /> I approve these ingredients and estimated amounts.</label>
          {!llmEnabled && <p className="banner warn">Automatic product selection needs an OpenAI key. You can enter ingredients above and search for products manually.</p>}
          <div className="row flow-actions"><button onClick={() => setStage("details")} disabled={busy}>Back</button>{llmEnabled ? <button className="primary" onClick={recommend} disabled={busy || !validIngredients || !confirmedIngredients}>{busy ? "Finding products…" : "Find products for me"}</button> : <button className="primary" onClick={() => setStage("products")} disabled={busy || !validIngredients || !confirmedIngredients}>Choose products</button>}</div>
        </section>
      )}
      {stage === "products" && (
        <section className="card">
          <p>Aimo chose matching products and enough whole packs where possible. Review the selections; you can search for alternatives.</p>
          <p className="muted small">Product matches are suggestions, not verified recipes. Confirm labels, allergies and dietary needs; terminal stock is unconfirmed.</p>
          <div className="basket-ingredients">{rows.map((row) => (
            <div className="basket-ingredient" key={row.id}>
              <b>{row.ingredient} · {Number(row.grams).toLocaleString()} g needed</b>
              {row.reason && <p className="muted small">{row.reason}</p>}
              {row.selected && row.products.find((product) => product.sku === row.selected)?.packWeightG && <p className="muted small">Selected packs provide {((row.products.find((product) => product.sku === row.selected)?.packWeightG ?? 0) * Number(row.packs)).toLocaleString()} g in total; you requested {Number(row.grams).toLocaleString()} g.</p>}
              <label>Search term<input disabled={busy} value={row.searchQuery} onChange={(e) => updateRow(row.id, { searchQuery: e.target.value })} placeholder={row.ingredient} /></label>
              <button disabled={busy} onClick={() => search(row)}>Search alternatives</button>
              {row.searched && !row.products.length && <p className="muted small">No suitable product selected. Search again or change the ingredient.</p>}
              {row.products.length > 0 && <><label>Product
                <select disabled={busy} value={row.selected} onChange={(e) => { const p = row.products.find((item) => item.sku === e.target.value); updateRow(row.id, { selected: e.target.value, packs: p?.packWeightG ? String(Math.ceil(Number(row.grams) / p.packWeightG)) : "", reason: "" }); }}>
                  <option value="">Select a product</option>{row.products.map((p) => <option key={p.sku} value={p.sku}>{p.name} · {eur(p.priceCents)} per pack{p.packWeightG ? ` · ${p.packWeightG / 1000} kg/pack` : " · pack weight unverified"}{!p.stockKnown ? " · stock unconfirmed" : ""}</option>)}
                </select></label>
                <label>Number of sales packs<input disabled={busy} type="number" min="1" step="1" value={row.packs} onChange={(e) => updateRow(row.id, { packs: e.target.value })} /></label></>}
            </div>
          ))}</div>
          <div className="row flow-actions"><button onClick={() => { setStage("ingredients"); setConfirmedIngredients(false); }} disabled={busy}>Change essentials</button><button className="primary" onClick={review} disabled={busy || !validRows}>Review basket prices</button></div>
        </section>
      )}
      {stage === "review" && preview && (
        <section className="card">
          <BasketSummary details={preview.details} />
          <p className="banner warn">Check product labels and allergens. Supplier-terminal quantities are unconfirmed. This is a simulation: no order will be sent to Valio.</p>
          <label className="budget-limit-choice"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I have reviewed these products, quantities, delivery dates and dietary requirements.</label>
          <div className="row flow-actions"><button onClick={() => setStage("products")} disabled={busy}>Change products</button><button className="primary" onClick={create} disabled={busy || !confirmed || !agentToken}>Confirm basket</button></div>
        </section>
      )}
      {stage === "order" && basket && (
        <section className="card">
          <BasketSummary details={basket.details} />
          <p className="banner warn">Simulation only: no order will be sent to Valio.</p>
          {basket.status === "awaiting_approval" && <><h3>Manager review required</h3><div className="row"><button className="primary" disabled={busy || !approverToken} onClick={() => action("approve")}>Approve basket</button><button disabled={busy || !approverToken} onClick={() => action("reject")}>Reject basket</button></div></>}
          {basket.status === "approved" && <><h3>Ready to order</h3><p>Prices, stock and delivery will be checked again before recording.</p><button className="primary" disabled={busy || !agentToken} onClick={() => action("submit")}>{busy ? "Processing order…" : "Place order"}</button></>}
          {basket.status === "submitted" && <div className="flow-complete" role="status"><span className="complete-mark" aria-hidden="true">✓</span><h3>Order recorded successfully</h3><p>Simulation only: no order was sent to Valio.</p><p>Reference: <b>{basket.providerOrderId}</b></p><button className="primary" onClick={onClose}>Done</button></div>}
          {basket.status === "rejected" && <><h3>Basket rejected</h3><p>No order was recorded. Start a new request to make changes.</p></>}
          <p className="muted small">Basket reference: {basket.id}</p>
          {error && <button onClick={() => { setBasket(null); setPreview(null); setStage("details"); setConfirmedIngredients(false); }}>Start a new review</button>}
        </section>
      )}
    </dialog>
  );
}

function BasketSummary({ details }: { details: BasketDetails }) {
  return <><h3>{details.input.description}</h3><p className="muted small">Delivery by {longDate(details.input.deliveryDate)}{details.input.dietaryNotes ? ` · Requirements to verify: ${details.input.dietaryNotes}` : ""}</p>
    <ul className="basket-lines">{details.lines.map((line) => <li key={line.sku}><div><b>{line.ingredient}</b><br />{line.name}<br /><span className="muted small">{line.packs} packs{line.packWeightG ? ` · ${line.packWeightG / 1000} kg per pack` : " · pack size unverified"}{details.input.lines.find((item) => item.sku === line.sku)?.requiredGrams != null ? ` · ${details.input.lines.find((item) => item.sku === line.sku)!.requiredGrams!.toLocaleString()} g approved` : ""} · {line.stockKnown ? "stock reported" : "stock unconfirmed"} · delivery {longDate(line.deliveryDate)}</span></div><b>{eur(line.lineTotalCents)}</b></li>)}</ul>
    <div className="total"><span>Total</span><b>{eur(details.totalCents)}</b></div>
    {details.approvalReasons.map((reason) => <p className="banner warn" key={reason}>{reason} Manager approval required.</p>)}
  </>;
}
