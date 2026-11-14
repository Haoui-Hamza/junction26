import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { configFromEnv, createApp } from "./app.js";

// Minimal .env loader (no extra dependency). Real environment variables take precedence.
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const cfg = configFromEnv();
cfg.staticDir = path.resolve("dist/web");
const { app, provider, clock } = createApp(cfg);
const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Aimo Order Guard listening on http://localhost:${port}`);
  console.log(`  provider: ${provider.info.label} (${cfg.provider})${cfg.provider === "valio" && !cfg.valio.apiKey ? " — WARNING: AIMO_API_KEY not set" : ""}`);
  console.log(`  clock:    ${clock.now().toISOString()}${clock.fixed ? " (fixed demo clock)" : ""}`);
  console.log(`  LLM agent:  ${cfg.llm.apiKey ? cfg.llm.model : "disabled (structured-form fallback available)"}`);
  console.log(`  OpenAPI:  http://localhost:${port}/openapi.json`);
});
