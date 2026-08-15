// Gemini vision/text for the Functional 04 AI shortcuts (spec §11). The key is
// server-only (GEMINI_API_KEY, never bundled to the client). AI ONLY produces a
// structured DRAFT that always lands in a review form — it never auto-saves, never
// assigns a tax profile, and never flips negative-stock policy (spec 11.2). On any
// provider failure (incl. a 429 after one retry) we throw AI_PREVIEW_FAILED so the
// UI falls back to manual entry with the draft intact (FR-06 / NFR "chaos AI").
import { DomainError } from "./errors.js";

const DEFAULT_MODEL = "gemini-flash-latest";
const TIMEOUT_MS = 15_000;

export function geminiEnabled() {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}
function model() {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
}
function endpoint() {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model()}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY.trim())}`;
}

// Structured-output schema (Gemini/OpenAPI subset). Fields are nullable so the
// model can leave anything it is unsure about blank rather than inventing it.
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    fields: {
      type: "object",
      properties: {
        display_name: { type: "string", nullable: true },
        product_type: { type: "string", enum: ["goods", "service"], nullable: true },
        unit_code: { type: "string", nullable: true },
        price_vnd: { type: "integer", nullable: true },
      },
      required: ["display_name", "product_type", "unit_code", "price_vnd"],
    },
    field_confidence: {
      type: "object",
      properties: {
        display_name: { type: "number", nullable: true },
        unit_code: { type: "number", nullable: true },
        price_vnd: { type: "number", nullable: true },
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: ["fields", "warnings"],
};

const PROMPT = [
  "Bạn giúp chủ tiệm tạp hóa Việt Nam nhập nhanh một mặt hàng từ ảnh chụp mặt trước sản phẩm.",
  "Chỉ TRÍCH XUẤT thông tin bạn NHÌN THẤY rõ trên nhãn. KHÔNG bịa. Nếu không chắc, để null.",
  "fields.display_name: tên sản phẩm gọn theo cách người bán gọi (kèm dung tích/khối lượng nếu có), tiếng Việt.",
  "fields.product_type: hầu như luôn là 'goods' cho hàng đóng gói.",
  "fields.unit_code: một trong item, chai, goi, hop, lon, kg, lit, thung — đoán theo bao bì; null nếu không rõ.",
  "fields.price_vnd: chỉ điền nếu có GIÁ IN trên nhãn (số nguyên VND), nếu không thì null.",
  "field_confidence: độ tin cậy 0..1 cho từng trường bạn điền.",
  "warnings: ghi chú ngắn nếu ảnh mờ hoặc thiếu thông tin.",
  "Tuyệt đối KHÔNG suy đoán mã số thuế hay nhóm kế toán.",
].join(" ");

async function callGemini(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(endpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function callWithRetry(body) {
  let res;
  try {
    res = await callGemini(body);
  } catch (e) {
    throw new DomainError("AI_PREVIEW_FAILED", "Không đọc được lúc này, bạn có thể nhập tay.");
  }
  if (res.status === 429) {
    // Free tier: one backoff retry, then hand off to manual.
    await new Promise((r) => setTimeout(r, 1500));
    try { res = await callGemini(body); } catch { throw new DomainError("AI_PREVIEW_FAILED"); }
  }
  if (!res.ok) {
    throw new DomainError("AI_PREVIEW_FAILED", "Không đọc được lúc này, bạn có thể nhập tay.");
  }
  return res.json();
}

const ALLOWED_UNITS = new Set(["item", "chai", "goi", "hop", "lon", "kg", "lit", "thung", "phan", "lan", "bo"]);

function clampConf(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

/** Normalise the model output into the draft the review form consumes. */
function normalizeDraft(parsed) {
  const f = parsed?.fields || {};
  const conf = parsed?.field_confidence || {};
  const name = typeof f.display_name === "string" ? f.display_name.trim() : null;
  let unit = typeof f.unit_code === "string" ? f.unit_code.trim().toLowerCase() : null;
  if (unit && !ALLOWED_UNITS.has(unit)) unit = null;
  let price = Number.isInteger(f.price_vnd) && f.price_vnd >= 0 ? f.price_vnd : null;
  const productType = f.product_type === "service" ? "service" : "goods";
  return {
    fields: { displayName: name || null, productType, unitCode: unit, priceVnd: price },
    fieldConfidence: {
      displayName: clampConf(conf.display_name),
      unitCode: clampConf(conf.unit_code),
      priceVnd: clampConf(conf.price_vnd),
    },
    warnings: Array.isArray(parsed?.warnings) ? parsed.warnings.filter((w) => typeof w === "string").slice(0, 5) : [],
  };
}

/**
 * Read a product label photo → structured draft with per-field confidence.
 * @param {string} base64  raw base64 (no data: prefix)
 * @param {string} mimeType e.g. image/jpeg, image/png
 */
export async function previewProductFromImage(base64, mimeType = "image/jpeg") {
  if (!geminiEnabled()) throw new DomainError("AI_PREVIEW_FAILED", "Chưa bật trợ lý AI.");
  if (!base64 || typeof base64 !== "string") throw new DomainError("VALIDATION", "Thiếu ảnh.");
  const body = {
    contents: [{ role: "user", parts: [{ text: PROMPT }, { inlineData: { mimeType, data: base64 } }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA, temperature: 0.2 },
  };
  const json = await callWithRetry(body);
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new DomainError("AI_PREVIEW_FAILED", "Kết quả AI không hợp lệ, bạn có thể nhập tay."); }
  return normalizeDraft(parsed);
}
