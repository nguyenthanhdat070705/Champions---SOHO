// AI Assistant orchestrator (Functional 10). One entry point: assistantChat().
// Membership/tenant auth happens in the router BEFORE this runs; here we build the
// merchant-scoped FACTS pack, ask Gemini (structured output), then GATE the reply:
//   • must parse, be non-empty, contain no forbidden terms, and every number must
//     appear in the FACTS (spec 4.2 grounding / F2 §9.3);
//   • a numeric answer must carry at least one source card (spec 3.5 / AST-FR-08).
// Any failure — model off, timeout, rate-limit, ungrounded number — falls back to
// the deterministic rule-based answerer, which is grounded by construction. We log
// one redacted line per exchange (no message content, no secrets — spec 2.3/4.4).
import { buildFacts, factsToText } from "./facts.js";
import { buildInstruction } from "./prompt.js";
import { generateAnswer } from "./gemini.js";
import { fallbackAnswer } from "./fallback.js";
import { numbersGrounded, numberTokens, ungroundedTokens } from "./numbers.js";
import { resolveSources, resolveActions } from "./registry.js";
import { geminiEnabled, geminiModel, MAX_TURNS } from "./config.js";

const FORBIDDEN_TERMS = ["công nợ", "chưa thu", "phải thu"];
function hasForbidden(text) {
  const lower = String(text || "").toLowerCase();
  return FORBIDDEN_TERMS.some((t) => lower.includes(t));
}

function latestUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant" && typeof messages[i].content === "string") {
      return messages[i].content;
    }
  }
  return "";
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

/**
 * @param {(text:string, params:any[]) => Promise<{rows:any[]}>} query  pooler query fn
 * @param {string} merchantId  already-authorized merchant
 * @param {Array<{role:string, content:string}>} messages  last ≤10 turns
 */
export async function assistantChat(query, merchantId, messages) {
  const started = nowMs();
  const turns = (Array.isArray(messages) ? messages : []).slice(-MAX_TURNS);
  const userText = latestUserText(turns);

  const facts = await buildFacts(query, merchantId);
  const factsText = factsToText(facts);

  let out = null;
  let mode = "fallback";
  let usedModel = null;
  let reason = geminiEnabled() ? "" : "no_key";

  if (geminiEnabled()) {
    try {
      const model = await generateAnswer(buildInstruction(factsText), turns);
      usedModel = geminiModel();
      if (hasForbidden(model.message)) {
        reason = "forbidden_term";
      } else if (!numbersGrounded(model.message, factsText)) {
        reason = "ungrounded_number";
      } else {
        // Grounding invariant: a numeric answer must have a source card.
        let sources = resolveSources(model.sourceKeys);
        if (sources.length === 0 && numberTokens(model.message).length > 0) {
          sources = resolveSources(fallbackAnswer(facts, userText).sourceKeys);
        }
        out = {
          kind: model.kind,
          reply: model.message,
          sources,
          actions: resolveActions(model.actionKeys),
        };
        mode = "ai";
      }
    } catch (e) {
      reason = e?.name === "AbortError" ? "timeout" : `error:${e?.status || e?.message || "unknown"}`;
    }
  }

  if (!out) {
    const fb = fallbackAnswer(facts, userText);
    out = {
      kind: fb.kind,
      reply: fb.message,
      sources: resolveSources(fb.sourceKeys),
      actions: resolveActions(fb.actionKeys),
    };
    mode = "fallback";
  }

  const ms = nowMs() - started;
  // Redacted operational log only (no message content, no secrets).
  const ungrounded = mode === "fallback" && reason === "ungrounded_number"
    ? ungroundedTokens(out.reply, factsText) // fallback text is grounded; kept for symmetry
    : undefined;
  console.log(
    `[assistant] ${JSON.stringify({ merchantId, ms, model: usedModel, mode, kind: out.kind, reason: reason || undefined, ungrounded })}`,
  );

  return {
    ...out,
    mode,
    model: usedModel,
    businessDate: facts.businessDate,
  };
}
