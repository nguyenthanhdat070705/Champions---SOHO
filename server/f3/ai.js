// Transaction-intelligence layer (spec 12). It NEVER sits on the payment
// critical path (FR-15) and never changes money/status. With no AI key this is a
// deterministic keyword classifier that returns the same structured shape a real
// provider would (category/confidence/reason/needsReview), so a provider can be
// dropped in later behind the same interface + guardrails.

const ALLOWED_CATEGORIES = ["food", "beverage", "service", "other"];
const CONFIDENCE_THRESHOLD = 0.85; // spec 12.3 pilot threshold

const KEYWORDS = {
  beverage: ["nước", "nuoc", "trà", "tra", "cà phê", "ca phe", "coffee", "bia", "beer", "sữa", "sua", "juice", "soda", "nước ngọt", "trà sữa", "tra sua", "sinh tố", "sinh to"],
  food: ["bánh", "banh", "cơm", "com", "phở", "pho", "bún", "bun", "mì", "mi", "xôi", "xoi", "chè", "che", "kem", "snack", "kẹo", "keo", "đồ ăn", "do an"],
  service: ["dịch vụ", "dich vu", "cắt", "cat", "sửa", "sua", "giặt", "giat", "rửa", "rua", "gội", "goi", "massage", "spa"],
};

function normalize(s) {
  return String(s || "").toLowerCase().trim();
}

/**
 * Suggest a revenue category from an item name. Deterministic; confidence below
 * the threshold always sets needsReview=true (spec 12.3). Never assigns a tax
 * rate — category only.
 */
export function suggestCategory(name) {
  const n = normalize(name);
  let best = { category: "other", confidence: 0.5 };
  for (const [category, words] of Object.entries(KEYWORDS)) {
    if (words.some((w) => n.includes(w))) {
      best = { category, confidence: 0.9 };
      break;
    }
  }
  const needsReview = best.confidence < CONFIDENCE_THRESHOLD;
  return {
    category: ALLOWED_CATEGORIES.includes(best.category) ? best.category : "other",
    confidence: best.confidence,
    reason: best.confidence >= 0.9
      ? `Tên hàng gợi ý nhóm "${best.category}".`
      : "Chưa đủ tín hiệu để phân nhóm chắc chắn.",
    needsReview,
    model: "deterministic-v1",
    promptVersion: "f3-suggest-1",
  };
}

/** Whether a suggestion result is well-formed and inside the allowed enum. */
export function validateSuggestion(s) {
  return (
    s &&
    ALLOWED_CATEGORIES.includes(s.category) &&
    typeof s.confidence === "number" &&
    s.confidence >= 0 &&
    s.confidence <= 1
  );
}

export { ALLOWED_CATEGORIES, CONFIDENCE_THRESHOLD };
