// Functional 06 — read a receiving document photo (hóa đơn / phiếu giao hàng)
// into a STRUCTURED DRAFT (spec 11 / 11.1). The key is server-only
// (GEMINI_API_KEY). AI only produces a draft that always lands in the review
// screen — it NEVER auto-posts, and every total is recomputed server-side
// (spec 11.2). On any provider failure we throw AI_EXTRACT_FAILED so the UI
// falls back to manual entry with the document still attached (REC-FR-12).
import { DomainError } from "../f3/errors.js";

const DEFAULT_MODEL = "gemini-flash-latest";
const TIMEOUT_MS = 20_000;

export function geminiEnabled() {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}
function model() {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
}
function endpoint() {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model()}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY.trim())}`;
}

// Structured-output schema (Gemini/OpenAPI subset), mirroring spec 11.1. Nullable
// fields so the model leaves what it can't read blank rather than inventing it.
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    supplier: { type: "string", nullable: true },
    received_date: { type: "string", nullable: true },
    document_number: { type: "string", nullable: true },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          quantity: { type: "number", nullable: true },
          unit_code: { type: "string", nullable: true },
          unit_cost_vnd: { type: "integer", nullable: true },
          confidence: { type: "number", nullable: true },
        },
        required: ["description"],
      },
    },
    totals: {
      type: "object",
      properties: { grand_total_vnd: { type: "integer", nullable: true } },
    },
    field_confidence: {
      type: "object",
      properties: {
        supplier: { type: "number", nullable: true },
        received_date: { type: "number", nullable: true },
        document_number: { type: "number", nullable: true },
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: ["lines", "warnings"],
};

const PROMPT = [
  "Bạn giúp chủ tiệm tạp hóa Việt Nam đọc một chứng từ NHẬP HÀNG (hóa đơn mua, phiếu giao hàng).",
  "Chỉ TRÍCH XUẤT thông tin bạn NHÌN THẤY rõ. KHÔNG bịa. Nếu không chắc, để null.",
  "supplier: tên nhà cung cấp/nơi bán ghi trên chứng từ.",
  "received_date: ngày trên chứng từ, định dạng YYYY-MM-DD; null nếu không rõ.",
  "document_number: số hóa đơn/phiếu nếu có.",
  "lines: mỗi dòng hàng gồm description (tên hàng như trên chứng từ), quantity (số lượng), unit_code (đơn vị nếu thấy: chai, thung, hop, kg…), unit_cost_vnd (đơn giá VND, số nguyên), confidence 0..1.",
  "totals.grand_total_vnd: tổng tiền ghi trên chứng từ (để đối chiếu, số nguyên VND).",
  "field_confidence: độ tin cậy 0..1 cho supplier/received_date/document_number.",
  "warnings: ghi chú ngắn nếu ảnh mờ, thiếu dòng, hay tổng không khớp.",
  "Tuyệt đối KHÔNG suy đoán mã số thuế, công nợ hay thông tin thanh toán.",
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
  } catch {
    throw new DomainError("AI_EXTRACT_FAILED");
  }
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 1500));
    try { res = await callGemini(body); } catch { throw new DomainError("AI_EXTRACT_FAILED"); }
  }
  if (!res.ok) throw new DomainError("AI_EXTRACT_FAILED");
  return res.json();
}

function clampConf(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

const ALLOWED_UNITS = new Set(["item", "chai", "goi", "hop", "lon", "kg", "lit", "thung", "phan", "lan", "bo"]);

/** Normalise the model output into the draft the review screen consumes. */
function normalizeExtraction(parsed) {
  const rawLines = Array.isArray(parsed?.lines) ? parsed.lines : [];
  const lines = rawLines
    .map((l) => {
      const description = typeof l?.description === "string" ? l.description.trim() : "";
      if (!description) return null;
      let unit = typeof l?.unit_code === "string" ? l.unit_code.trim().toLowerCase() : null;
      if (unit && !ALLOWED_UNITS.has(unit)) unit = null;
      const quantity = Number.isFinite(Number(l?.quantity)) && Number(l.quantity) > 0 ? Number(l.quantity) : null;
      const unitCost = Number.isInteger(l?.unit_cost_vnd) && l.unit_cost_vnd >= 0 ? l.unit_cost_vnd : null;
      return { description: description.slice(0, 200), quantity, unitCode: unit, unitCostVnd: unitCost, confidence: clampConf(l?.confidence) };
    })
    .filter(Boolean)
    .slice(0, 100);

  const fc = parsed?.field_confidence || {};
  return {
    supplier: typeof parsed?.supplier === "string" ? parsed.supplier.trim().slice(0, 160) || null : null,
    receivedDate: typeof parsed?.received_date === "string" ? parsed.received_date.trim().slice(0, 10) || null : null,
    documentNumber: typeof parsed?.document_number === "string" ? parsed.document_number.trim().slice(0, 60) || null : null,
    lines,
    totalHintVnd: Number.isInteger(parsed?.totals?.grand_total_vnd) ? parsed.totals.grand_total_vnd : null,
    fieldConfidence: {
      supplier: clampConf(fc.supplier),
      receivedDate: clampConf(fc.received_date),
      documentNumber: clampConf(fc.document_number),
    },
    warnings: Array.isArray(parsed?.warnings) ? parsed.warnings.filter((w) => typeof w === "string").slice(0, 5) : [],
  };
}

/**
 * Read a receiving document photo → structured extraction.
 * @param {string} base64 raw base64 (no data: prefix)
 * @param {string} mimeType e.g. image/jpeg
 */
export async function extractReceiptFromImage(base64, mimeType = "image/jpeg") {
  if (!geminiEnabled()) throw new DomainError("AI_EXTRACT_FAILED", "Chưa bật trợ lý AI.");
  if (!base64 || typeof base64 !== "string") throw new DomainError("VALIDATION", "Thiếu ảnh.");
  const body = {
    contents: [{ role: "user", parts: [{ text: PROMPT }, { inlineData: { mimeType, data: base64 } }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA, temperature: 0.2 },
  };
  const json = await callWithRetry(body);
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new DomainError("AI_EXTRACT_FAILED", "Kết quả AI không hợp lệ, bạn có thể nhập tay."); }
  return normalizeExtraction(parsed);
}
