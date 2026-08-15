// Biên nhận (internal receipt) — created after a bill is paid (FR-12). This is
// NEVER labelled "hóa đơn điện tử" (HĐĐT); e-invoices are a separate job/table
// out of MVP scope. One receipt per order (receipts.order_id is unique).
import { getPool } from "../db/pool.js";
import { receiptNumber } from "./numbering.js";
import { formatVnd } from "./format.js";

/**
 * Ensure a receipt row exists for a paid order (idempotent via order_id unique).
 * Runs inside the caller's transaction so it commits with the payment.
 */
export async function ensureReceipt(client, merchantId, orderId, receiptPrefix, businessDate) {
  const existing = await client.query(
    `select id, receipt_number from public.receipts where order_id = $1`,
    [orderId],
  );
  if (existing.rows.length > 0) return existing.rows[0];
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { rows } = await client.query(
        `insert into public.receipts (merchant_id, order_id, receipt_number) values ($1,$2,$3)
         returning id, receipt_number`,
        [merchantId, orderId, receiptNumber(receiptPrefix, businessDate)],
      );
      return rows[0];
    } catch (err) {
      if (err?.code === "23505" && /receipt_number/.test(err.message)) continue;
      if (err?.code === "23505" && /order_id/.test(err.message)) {
        const r = await client.query(`select id, receipt_number from public.receipts where order_id=$1`, [orderId]);
        return r.rows[0];
      }
      throw err;
    }
  }
  return null;
}

/**
 * Render a simple, self-contained HTML "Biên nhận" for a paid bill. Used by the
 * receipt view/share screen. No external assets; safe to serve inline.
 */
export async function renderReceiptHtml(merchantId, orderId) {
  const pool = getPool();
  const o = await pool.query(
    `select o.*, m.display_name as merchant_name
       from public.orders o join public.merchants m on m.id = o.merchant_id
      where o.id = $1 and o.merchant_id = $2`,
    [orderId, merchantId],
  );
  if (o.rows.length === 0) return null;
  const order = o.rows[0];
  const items = await pool.query(
    `select * from public.order_items where order_id=$1 order by line_no`, [orderId]);
  const receipt = await pool.query(
    `select receipt_number from public.receipts where order_id=$1`, [orderId]);
  const payment = await pool.query(
    `select method, amount, cash_received, change_due, paid_at from public.payments
      where order_id=$1 and status='succeeded' limit 1`, [orderId]);

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const rn = receipt.rows[0]?.receipt_number || order.order_number;
  const pay = payment.rows[0];
  const methodLabel = pay ? (pay.method === "cash" ? "Tiền mặt" : "QR") : "—";

  const rows = items.rows.map((it) => `
    <tr>
      <td>${esc(it.name_snapshot)}<div class="q">${esc(it.unit_code_snapshot)} · ${Number(it.quantity)} × ${formatVnd(Number(it.unit_price))}</div></td>
      <td class="r">${formatVnd(Number(it.net_amount))}</td>
    </tr>`).join("");

  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Biên nhận ${esc(rn)}</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#eef3f6;margin:0;padding:16px;color:#12314d}
  .r{text-align:right} .card{max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:20px;box-shadow:0 6px 22px rgba(18,49,77,.08)}
  h1{font-size:18px;margin:0 0 2px} .sub{color:#6b7a89;font-size:13px;margin-bottom:14px}
  table{width:100%;border-collapse:collapse} td{padding:8px 0;border-bottom:1px dashed #e4eaf0;vertical-align:top;font-size:14px}
  .q{color:#6b7a89;font-size:12px;margin-top:2px}
  .tot{display:flex;justify-content:space-between;padding:6px 0;font-size:14px}
  .tot--big{font-weight:800;font-size:18px;border-top:2px solid #12314d;margin-top:8px;padding-top:10px}
  .badge{display:inline-block;background:#e6f4f2;color:#0d7a6f;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:700;margin-top:10px}
  .note{color:#6b7a89;font-size:11px;text-align:center;margin-top:16px}
</style></head><body>
<div class="card">
  <h1>${esc(order.merchant_name)}</h1>
  <div class="sub">Biên nhận ${esc(rn)} · ${esc(order.order_number)}</div>
  <table>${rows}</table>
  <div class="tot"><span>Tạm tính</span><span>${formatVnd(Number(order.subtotal_amount))}</span></div>
  ${Number(order.discount_amount) > 0 ? `<div class="tot"><span>Giảm giá</span><span>−${formatVnd(Number(order.discount_amount))}</span></div>` : ""}
  <div class="tot tot--big"><span>Tổng thanh toán</span><span>${formatVnd(Number(order.total_amount))}</span></div>
  ${pay ? `<div class="tot"><span>Phương thức</span><span>${methodLabel}</span></div>` : ""}
  ${pay && pay.cash_received != null ? `<div class="tot"><span>Khách đưa</span><span>${formatVnd(Number(pay.cash_received))}</span></div><div class="tot"><span>Tiền thối</span><span>${formatVnd(Number(pay.change_due || 0))}</span></div>` : ""}
  <span class="badge">Đã thanh toán</span>
  <div class="note">Biên nhận nội bộ — không phải hóa đơn điện tử (HĐĐT)</div>
</div></body></html>`;
}
