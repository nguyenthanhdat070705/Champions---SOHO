// Thin Gemini (generateContent) client for the assistant. The API key is a
// backend secret and is NEVER sent to the client or logged. One hard timeout, one
// retry on transient failure (429 / 5xx / network), then the caller falls back to
// the deterministic answerer — so a slow or rate-limited model never blocks the
// page (spec 11.2 / AST_010).
import { geminiApiKey, geminiModel, GEMINI_TIMEOUT_MS } from "./config.js";
import { RESPONSE_SCHEMA } from "./prompt.js";

const ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

/** Map our {role: user|assistant} turns → Gemini contents (assistant→model). */
function toContents(messages) {
  const out = [];
  for (const m of messages || []) {
    const role = m.role === "assistant" ? "model" : "user";
    const text = typeof m.content === "string" ? m.content : "";
    if (!text.trim()) continue;
    out.push({ role, parts: [{ text }] });
  }
  // Gemini requires the conversation to end on a user turn.
  if (out.length === 0 || out[out.length - 1].role !== "user") {
    out.push({ role: "user", parts: [{ text: "Xin chào" }] });
  }
  return out;
}

async function callOnce(instruction, messages, signal) {
  const body = {
    systemInstruction: { parts: [{ text: instruction }] },
    contents: toContents(messages),
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 700,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  };
  const res = await fetch(`${ENDPOINT(geminiModel())}?key=${encodeURIComponent(geminiApiKey())}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const err = new Error(`gemini ${res.status}`);
    err.status = res.status;
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  // Skip any reasoning/"thought" parts; keep only the visible JSON text.
  const text = parts.filter((p) => !p?.thought).map((p) => p?.text || "").join("").trim();
  if (!text) throw new Error("gemini empty response");
  return text;
}

/** Parse the model's JSON → normalized { kind, message, sourceKeys, actionKeys }. */
export function parseModelJson(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    // Some models wrap JSON in prose/code fences; grab the outermost object.
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("gemini non-JSON");
    obj = JSON.parse(m[0]);
  }
  const message = typeof obj.message === "string" ? obj.message.trim() : "";
  if (!message) throw new Error("gemini missing message");
  return {
    kind: obj.kind === "refusal" ? "refusal" : "answer",
    message,
    sourceKeys: Array.isArray(obj.source_keys) ? obj.source_keys : [],
    actionKeys: Array.isArray(obj.action_keys) ? obj.action_keys : [],
  };
}

/**
 * Generate an answer. Throws on total failure (caller falls back). Enforces a
 * hard timeout and retries a transient failure once.
 */
export async function generateAnswer(instruction, messages) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT_MS);
    try {
      const text = await callOnce(instruction, messages, ctrl.signal);
      return parseModelJson(text);
    } catch (e) {
      lastErr = e;
      const transient = e.name === "AbortError" || e.retryable || e.status === undefined;
      if (attempt === 0 && transient) continue; // one retry
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error("gemini failed");
}
