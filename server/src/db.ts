import Database from "better-sqlite3";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  auto_limit_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  substitution TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  request_json TEXT NOT NULL,
  option_kind TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  provider_order_id TEXT,
  status_reason TEXT,
  client_request_id TEXT UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Immutable revisions of the proposal terms. A changed offer creates a new revision; old ones are never edited.
CREATE TABLE IF NOT EXISTS order_revisions (
  order_id TEXT NOT NULL REFERENCES orders(id),
  revision INTEGER NOT NULL,
  terms_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  change_reason TEXT,
  diff_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (order_id, revision)
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  revision INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  reason TEXT,
  at TEXT NOT NULL,
  UNIQUE (order_id, revision)
);

-- Persisted before the provider is called. The submission key is stable per (order, revision, fingerprint).
CREATE TABLE IF NOT EXISTS submissions (
  submission_key TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  revision INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','succeeded','unknown','aborted','failed')),
  provider_order_id TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  revision INTEGER,
  data_json TEXT
);

-- Local provider tables (the seeded "supplier" side).
CREATE TABLE IF NOT EXISTS provider_offers (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  attributes_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  pack_volume_ml INTEGER,
  price_cents INTEGER,
  available_packs INTEGER NOT NULL,
  delivery_date TEXT,
  closing_time TEXT,
  sales_block INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS provider_orders (
  id TEXT PRIMARY KEY,
  submission_key TEXT NOT NULL UNIQUE,
  lines_json TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- Monotonic counters that survive demo resets, so IDs are never reused.
CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_state (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export function nextCounter(db: DB, name: string): number {
  return (db.prepare("INSERT INTO counters(name,value) VALUES(?,1) ON CONFLICT(name) DO UPDATE SET value=value+1 RETURNING value").get(name) as { value: number }).value;
}

export function openDb(path = ":memory:"): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
