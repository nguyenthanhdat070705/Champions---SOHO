// Number grounding guardrail (spec 4.2 "Số liệu ... Khi thiếu nguồn → Không đưa
// con số"; brief post-check mirroring F2 spec 9.3). The model may only state
// numbers that appear in the facts pack we sent it. Any number in the reply whose
// canonical digit-string is NOT present in the facts is treated as a hallucination
// and the whole reply is discarded in favour of the deterministic fallback.
//
// A "number token" is a run of digits optionally grouped with "." or "," (VN
// thousands grouping, e.g. "1.234.000"). We canonicalise by stripping the
// separators, so "1.234.000đ", "500ml" and "3 bill" tokenise to "1234000", "500"
// and "3". The SAME tokeniser runs over both the facts text and the reply, so any
// digit-run we put in the facts (formatted money, counts, quantities, dates,
// percentages, numbers inside product names) is automatically allowed.

const TOKEN_RE = /\d[\d.,]*/g;

/** Canonical digit-strings for every number-like token in `text`. */
export function numberTokens(text) {
  const out = [];
  if (typeof text !== "string") return out;
  const matches = text.match(TOKEN_RE);
  if (!matches) return out;
  for (const m of matches) {
    const canonical = m.replace(/[.,]/g, "");
    if (canonical.length > 0) out.push(canonical);
  }
  return out;
}

/** The set of allowed canonical digit-strings, built from the facts text. */
export function allowedNumberSet(factsText) {
  return new Set(numberTokens(factsText));
}

/**
 * True when every number in `reply` also appears in `factsText`. An empty reply
 * or a reply with no numbers is trivially grounded (the caller still checks the
 * text is non-empty separately).
 */
export function numbersGrounded(reply, factsText) {
  const allowed = allowedNumberSet(factsText);
  for (const tok of numberTokens(reply)) {
    if (!allowed.has(tok)) return false;
  }
  return true;
}

/** The specific ungrounded tokens (for logging / debugging), else []. */
export function ungroundedTokens(reply, factsText) {
  const allowed = allowedNumberSet(factsText);
  return numberTokens(reply).filter((t) => !allowed.has(t));
}
