// Server-only config for the SoHo AI Assistant (Functional 10). The Gemini key
// is a backend secret — it lives ONLY in the server .env, never in the client
// bundle, prompt, log or tool result (spec 12.2). When no key is configured the
// assistant still works: every answer falls back to the deterministic rule-based
// answerer (spec 11.2 / AST-FR-12), so the page is useful even with AI off.

export function geminiApiKey() {
  return process.env.GEMINI_API_KEY?.trim() || "";
}

export function geminiModel() {
  return process.env.GEMINI_MODEL?.trim() || "gemini-flash-latest";
}

export function geminiEnabled() {
  return geminiApiKey().length > 0;
}

/** Hard timeout for a single Gemini call (spec NFR read p95 < 5s → 6s ceiling). */
export const GEMINI_TIMEOUT_MS = 6000;

/** How many trailing conversation turns we forward to the model (brief: ≤10). */
export const MAX_TURNS = 10;
