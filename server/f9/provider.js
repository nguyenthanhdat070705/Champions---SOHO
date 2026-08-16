// Functional 09 — the e-invoice provider adapter boundary (spec 7 "Provider adapter
// — one interface", 12.2). NO real e-invoice provider is signed yet, so everything
// runs against a MockProvider behind this clean interface. A real provider later is
// ONE new adapter object implementing the same shape — zero changes to invoices.js,
// the webhook, or the client. The mock is labelled honestly in the UI:
//   "Nhà cung cấp thử nghiệm — chưa nối cơ quan thuế".
//
// The provider NEVER decides acceptance synchronously: createSubmission only ACKs
// (spec 4.2 "HTTP 2xx ≠ accepted"). Acceptance/rejection arrives later via a signed
// webhook event (driven in dev by the simulate endpoint).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Server-only mock signing secret (never sent to the client/AI). */
export function mockSecret() {
  return process.env.EINVOICE_MOCK_SECRET || "soho-mock-einvoice-dev-secret";
}

const PROVIDERS = new Map();

/** Register (used at module load) and look up a provider by code (allowlist). */
export function registerProvider(provider) {
  PROVIDERS.set(provider.code, provider);
  return provider;
}

/** Resolve an allowlisted provider adapter, or null when the code is unknown. */
export function getProvider(code) {
  return PROVIDERS.get(code) || null;
}

function sha256(s) {
  return createHash("sha256").update(String(s)).digest("hex");
}

/** HMAC-SHA256 hex signature of a raw body string with the mock secret. */
export function signBody(bodyString, secret = mockSecret()) {
  return createHmac("sha256", secret).update(String(bodyString)).digest("hex");
}

/** Timing-safe verification that `signature` matches `bodyString` (spec 12.2). */
export function verifyBody(bodyString, signature, secret = mockSecret()) {
  if (typeof signature !== "string" || !signature) return false;
  const expected = signBody(bodyString, secret);
  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

/**
 * The MockProvider. Stateless server-side: acceptance is externally driven via a
 * signed webhook/simulate event, exactly like a real provider integration.
 */
export const MockProvider = registerProvider({
  code: "mock",
  /** Honest UI label — this is NOT a tax-authority-connected provider. */
  label: "Nhà cung cấp thử nghiệm — chưa nối cơ quan thuế",

  /**
   * Submit a frozen payload. Returns a deterministic provider reference (derived
   * from the payload hash so a replay maps to the same ref) and an ACK only.
   * @returns {{ providerRef, status, requestHash, responseHash, message }}
   */
  createSubmission({ invoiceId, payloadHash, clientRequestId }) {
    const seed = payloadHash || clientRequestId || invoiceId;
    const providerRef = `MOCK-${sha256(seed).slice(0, 16).toUpperCase()}`;
    const requestHash = sha256(`${invoiceId}|${payloadHash}|${clientRequestId}`);
    const responseHash = sha256(`${providerRef}|received`);
    return { providerRef, status: "received", requestHash, responseHash, message: "Đã tiếp nhận (thử nghiệm)" };
  },

  /**
   * Reconcile poll (spec 10 GET status). The mock holds no async state of its own,
   * so it reports "pending" — the authoritative state lives in the DB events the
   * webhook/simulate has (or has not yet) delivered. A real adapter would query the
   * provider here.
   */
  getStatus() {
    return { status: "pending" };
  },

  verifySignature(bodyString, signature) {
    return verifyBody(bodyString, signature);
  },

  signEvent(eventObject) {
    return signBody(JSON.stringify(eventObject));
  },

  /**
   * Build the placeholder XML/PDF artifacts from a frozen accepted invoice (spec
   * 1.1, INV-FR-09). Deterministic content → stable hashes. A real provider returns
   * a signed XML + rendered PDF; these are clearly-labelled test placeholders.
   */
  buildArtifacts(invoice) {
    const xml = buildMockXml(invoice);
    const pdf = buildMockPdfText(invoice);
    return {
      xml: { contentType: "application/xml; charset=utf-8", body: xml, hash: sha256(xml), filename: `${invoice.providerInvoiceRef || invoice.id}.xml` },
      pdf: { contentType: "text/plain; charset=utf-8", body: pdf, hash: sha256(pdf), filename: `${invoice.providerInvoiceRef || invoice.id}.pdf.txt` },
    };
  },
});

function esc(s) {
  return String(s ?? "").replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

/** A minimal, honest placeholder XML (NOT a real TT78/NĐ123 XML). */
export function buildMockXml(invoice) {
  const seller = invoice.sellerSnapshot || {};
  const buyer = invoice.buyerSnapshot || {};
  const lines = invoice.items || [];
  const lineXml = lines.map((l) => `    <line>
      <desc>${esc(l.description)}</desc>
      <qty>${esc(l.quantity)}</qty>
      <unitPrice>${esc(l.unitPriceVnd)}</unitPrice>
      <taxCode>${esc(l.taxCode)}</taxCode>
      <lineTotal>${esc(l.lineTotalVnd)}</lineTotal>
      <tax>${esc(l.taxVnd)}</tax>
    </line>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<eInvoice provider="mock" note="TEST PLACEHOLDER — chua noi co quan thue">
  <ref>${esc(invoice.providerInvoiceRef || "")}</ref>
  <status>${esc(invoice.status)}</status>
  <ruleSetVersion>${esc(invoice.ruleSetVersion)}</ruleSetVersion>
  <seller><name>${esc(seller.legalName)}</name><taxCode>${esc(seller.taxCode)}</taxCode></seller>
  <buyer><kind>${esc(buyer.kind)}</kind><name>${esc(buyer.name)}</name><taxCode>${esc(buyer.taxCode)}</taxCode></buyer>
  <lines>
${lineXml}
  </lines>
  <totals><subtotal>${esc(invoice.subtotalVnd)}</subtotal><tax>${esc(invoice.taxVnd)}</tax><total>${esc(invoice.totalVnd)}</total></totals>
  <payloadHash>${esc(invoice.payloadHash)}</payloadHash>
</eInvoice>`;
}

/** A plain-text stand-in for the PDF (kept text so it is trivially embeddable). */
export function buildMockPdfText(invoice) {
  const seller = invoice.sellerSnapshot || {};
  const buyer = invoice.buyerSnapshot || {};
  const lines = (invoice.items || []).map(
    (l) => `  - ${l.description} x${l.quantity} = ${l.lineTotalVnd}đ (${l.taxCode})`,
  ).join("\n");
  return [
    "HÓA ĐƠN ĐIỆN TỬ — BẢN THỬ NGHIỆM (chưa nối cơ quan thuế)",
    `Mã tra cứu (thử nghiệm): ${invoice.providerInvoiceRef || "-"}`,
    `Người bán: ${seller.legalName || "-"} — MST ${seller.taxCode || "-"}`,
    `Người mua: ${buyer.name || "Khách lẻ"}${buyer.taxCode ? " — MST " + buyer.taxCode : ""}`,
    "Dòng hàng:",
    lines,
    `Tạm tính: ${invoice.subtotalVnd}đ  |  Thuế: ${invoice.taxVnd}đ  |  Tổng: ${invoice.totalVnd}đ`,
    `payload_hash: ${invoice.payloadHash || "-"}`,
  ].join("\n");
}
