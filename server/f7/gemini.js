// Functional 07 — receipt/PDF photo → structured expense DRAFT (spec §11).
// "Chụp hoặc nói là xong" but ALWAYS with a human review point: this only produces
// a draft that lands in the review form. It NEVER auto-posts, never concludes tax
// deductibility, and every total is recomputed by the server (spec 11.2 guardrails
// / EXP-09). GEMINI_API_KEY is server-only. On any provider failure (incl. a 429
// after one retry) we throw AI_PREVIEW_FAILED so the UI falls back to manual entry
// with the draft/source intact (EXP-FR-12 / EXP-05).
import { DomainError } from "../f3/errors.js";
import { round3 } from "./money.js";

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

// Structured-output schema — every field nullable so the model leaves blanks
// rather than inventing data (mirrors spec 11.1 JSON Schema).
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    payee: { type: "string", nullable: true },
    expense_date: { type: "string", nullable: true }, // YYYY-MM-DD
    document_number: { type: "string", nullable: true },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          quantity: { type: "number", nullable: true },
          unit_cost_vnd: { type: "integer", nullable: true },
        },
        required: ["description"],
      },
    },
    total_vnd: { type: "integer", nullable: true },
    tax_vnd: { type: "integer", nullable: true },
    category_candidates: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: ["payee", "expense_date", "lines", "warnings"],
};

const PROMPT = [
  "Bạn giúp chủ hộ kinh doanh Việt Nam ghi nhanh một KHOẢN CHI từ ảnh chụp hóa đơn/chứng từ.",
  "Chỉ TRÍCH XUẤT thông tin bạn NHÌN THẤY rõ trên chứng từ. KHÔNG bịa. Không chắc thì để null.",
  "payee: tên bên NHẬN tiền (nhà cung cấp, cửa hàng, đơn vị điện/nước…).",
  "expense_date: ngày trên chứng từ, định dạng YYYY-MM-DD.",
  "document_number: số hóa đơn/chứng từ nếu có.",
  "lines: từng dòng hàng/dịch vụ (description, quantity, unit_cost_vnd là số nguyên VND). Bỏ qua nếu không rõ.",
  "total_vnd, tax_vnd: tổng và thuế IN trên chứng từ (số nguyên VND) — chỉ để đối chiếu, hệ thống tự tính lại.",
  "category_candidates: gợi ý nhóm chi bằng tiếng Việt đời thường (vd: Điện nước, Nhập hàng, Mặt bằng).",
  "warnings: ghi chú ngắn nếu ảnh mờ/thiếu.",
  "TUYỆT ĐỐI KHÔNG kết luận khoản này được khấu trừ thuế hay hợp lệ kế toán.",
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
    throw new DomainError("AI_PREVIEW_FAILED");
  }
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 1500));
    try { res = await callGemini(body); } catch { throw new DomainError("AI_PREVIEW_FAILED"); }
  }
  if (!res.ok) throw new DomainError("AI_PREVIEW_FAILED");
  return res.json();
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function cleanStr(x, max = 200) {
  if (typeof x !== "string") return null;
  const s = x.trim();
  return s ? s.slice(0, max) : null;
}
function cleanInt(x) {
  return Number.isFinite(x) && Number(x) >= 0 ? Math.round(Number(x)) : null;
}

/** Normalise raw model output into the draft the review form consumes. */
export function normalizeReceiptDraft(parsed) {
  const rawLines = Array.isArray(parsed?.lines) ? parsed.lines : [];
  const lines = rawLines
    .map((l) => {
      const description = cleanStr(l?.description, 200);
      if (!description) return null;
      const qty = Number.isFinite(l?.quantity) && Number(l.quantity) > 0 ? round3(l.quantity) : 1;
      const unit = cleanInt(l?.unit_cost_vnd) ?? 0;
      return { description, quantity: qty, unitCostVnd: unit, source: "ocr" };
    })
    .filter(Boolean)
    .slice(0, 100);
  const date = ISO_DATE.test(String(parsed?.expense_date || "")) ? parsed.expense_date : null;
  return {
    payee: cleanStr(parsed?.payee, 200),
    expenseDate: date,
    documentNumber: cleanStr(parsed?.document_number, 60),
    lines,
    totalVnd: cleanInt(parsed?.total_vnd),
    taxVnd: cleanInt(parsed?.tax_vnd),
    categoryCandidates: Array.isArray(parsed?.category_candidates)
      ? parsed.category_candidates.filter((s) => typeof s === "string").map((s) => s.trim()).filter(Boolean).slice(0, 4)
      : [],
    warnings: Array.isArray(parsed?.warnings)
      ? parsed.warnings.filter((w) => typeof w === "string").slice(0, 5)
      : [],
  };
}

/**
 * Read a receipt photo → structured draft.
 * @param {string} base64  raw base64 (no data: prefix)
 * @param {string} mimeType e.g. image/jpeg, image/png
 */
export async function previewExpenseFromImage(base64, mimeType = "image/jpeg") {
  if (!geminiEnabled()) throw new DomainError("AI_PREVIEW_FAILED", "Chưa bật trợ lý AI.");
  if (!base64 || typeof base64 !== "string") throw new DomainError("VALIDATION", "Thiếu ảnh.");
  const body = {
    contents: [{ role: "user", parts: [{ text: PROMPT }, { inlineData: { mimeType, data: base64 } }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA, temperature: 0.2 },
  };
  const json = await callWithRetry(body);
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new DomainError("AI_PREVIEW_FAILED"); }
  return { draft: normalizeReceiptDraft(parsed), model: model() };
}
