import { createHash } from "node:crypto";

export const TZ = "Europe/Helsinki";

export function formatEur(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}€${euros}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatLitres(ml: number): string {
  const l = ml / 1000;
  return `${Number.isInteger(l) ? l.toLocaleString("en-US") : l.toLocaleString("en-US", { maximumFractionDigits: 3 })} L`;
}

/** YYYY-MM-DD of an instant in Europe/Helsinki. */
export function helsinkiDate(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Day of week (0=Sunday) of a YYYY-MM-DD calendar date. */
export function weekday(isoDate: string): number {
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay();
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function describeDate(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return Math.abs(a);
}

export interface Clock {
  now(): Date;
  fixed: boolean;
}

export function makeClock(fixedIso?: string | null): Clock {
  if (fixedIso) {
    const t = new Date(fixedIso);
    if (Number.isNaN(t.getTime())) throw new Error(`Invalid FIXED_CLOCK: ${fixedIso}`);
    return { now: () => new Date(t), fixed: true };
  }
  return { now: () => new Date(), fixed: false };
}
