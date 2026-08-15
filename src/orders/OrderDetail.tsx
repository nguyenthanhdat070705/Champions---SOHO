// "Chi tiết bill" + "Trả hàng / Hoàn tiền" (spec 3.11 / 3.12 / 6). The original
// paid bill is never edited; returns create reversing documents. Cash refunds are
// succeeded immediately; bank_transfer refunds are saved pending ("Lưu chờ xử
// lý") and only reduce revenue once confirmed. Old bills without line items show
// totals only.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../components/ui";
import { api, ApiError, fetchText, newIdempotencyKey } from "../lib/api";
import type { OrderView } from "../lib/api";
import { formatVnd, formatClockVN } from "../lib/format";
import { IconMinus, IconPlus } from "../components/icons";
import { Sheet, InlineError } from "../sales/ui";

function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n).replace(/\.?0+$/, "");
}

interface ReturnRow { id: string; status: string; refundTotal: number; items?: { orderItemId: string; quantity: number; condition: string; refundAmount: number }[]; refunds?: { id: string; method: string; status: string; amount: number }[]; }

export function OrderDetail() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const [view, setView] = useState<OrderView | null>(null);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [returning, setReturning] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [receiptHtml, setReceiptHtml] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setView(await api.getOrder(id)); } catch { setView(null); } finally { setLoading(false); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function viewReceipt() {
    setReceiptOpen(true);
    if (!receiptHtml) {
      try { setReceiptHtml(await fetchText(api.receiptUrl(id))); }
      catch { setReceiptHtml("<p style='padding:20px'>Không tải được biên nhận.</p>"); }
    }
  }

  if (loading) return <div className="center-screen"><div className="spinner" /></div>;
  if (!view) return (
    <div className="screen screen--tabbed"><PageHeader title="Chi tiết bill" onBack={() => nav("/don-hang")} />
      <div className="content--plain"><div className="empty"><div className="empty__t">Không tìm thấy bill</div></div></div></div>
  );

  const { order, items, payments } = view;
  const returns = (view.returns ?? []) as unknown as ReturnRow[];
  const paidPayment = payments.find((p) => p.status === "succeeded");
  const isPaid = ["paid", "partially_refunded", "refunded"].includes(order.status);
  const refundable = isPaid && order.status !== "refunded";
  const pendingRefund = returns.flatMap((r) => r.refunds ?? []).find((rf) => rf.status === "pending");

  if (returning) {
    return <ReturnFlow view={view} onBack={() => setReturning(false)} onDone={() => { setReturning(false); void load(); }} />;
  }

  return (
    <div className="screen screen--tabbed">
      <PageHeader
        title="Chi tiết bill"
        onBack={() => nav("/don-hang")}
        right={
          <div style={{ position: "relative" }}>
            <button className="step__back" onClick={() => setMenuOpen((v) => !v)} aria-label="Tác vụ">⋯</button>
            {menuOpen && (
              <div className="pos-menu" onMouseLeave={() => setMenuOpen(false)}>
                {refundable && <button onClick={() => { setMenuOpen(false); setReturning(true); }}>Trả hàng / Hoàn tiền</button>}
                {paidPayment && <button onClick={() => { setMenuOpen(false); void viewReceipt(); }}>Xem biên nhận</button>}
              </div>
            )}
          </div>
        }
      />
      <div className="content--plain stack">
        <div className="card card--flat">
          <div className="row-between">
            <div>
              <div className="bill-row__num">{order.orderNumber}</div>
              <div className="muted tiny">{formatClockVN(order.paidAt ?? order.createdAt)}</div>
            </div>
            <StatusChip status={order.status} />
          </div>
        </div>

        <div className="card card--flat">
          <div className="section-title" style={{ marginTop: 0 }}>Sản phẩm</div>
          {items.length === 0 ? (
            <div className="muted tiny">Bill cũ không có chi tiết dòng.</div>
          ) : (
            items.map((it) => (
              <div key={it.id} className="detail-line">
                <div>
                  <div className="detail-line__name">{it.name}</div>
                  <div className="muted tiny">{fmtQty(it.quantity)} × {formatVnd(it.unitPrice)}{it.discountAmount > 0 ? ` · giảm ${formatVnd(it.discountAmount)}` : ""}</div>
                </div>
                <div className="detail-line__amt">{formatVnd(it.netAmount)}</div>
              </div>
            ))
          )}
          <div className="summary-row" style={{ marginTop: 8 }}><span className="summary-row__k">Tổng hàng</span><span className="summary-row__v">{formatVnd(order.subtotalAmount)}</span></div>
          {order.discountAmount > 0 && <div className="summary-row"><span className="summary-row__k">Giảm giá</span><span className="summary-row__v">−{formatVnd(order.discountAmount)}</span></div>}
          <div className="summary-row summary-row--total"><span className="summary-row__k">Tổng thanh toán</span><span className="summary-row__v">{formatVnd(order.totalAmount)}</span></div>
        </div>

        {paidPayment && (
          <div className="card card--flat">
            <div className="section-title" style={{ marginTop: 0 }}>Thanh toán</div>
            <div className="summary-row"><span className="summary-row__k">Phương thức</span><span className="summary-row__v">{paidPayment.method === "cash" ? "Tiền mặt" : "QR"}</span></div>
            <div className="summary-row"><span className="summary-row__k">Số tiền</span><span className="summary-row__v">{formatVnd(paidPayment.amount)}</span></div>
            {paidPayment.changeDue != null && paidPayment.changeDue > 0 && <div className="summary-row"><span className="summary-row__k">Tiền thối</span><span className="summary-row__v">{formatVnd(paidPayment.changeDue)}</span></div>}
            <div className="summary-row"><span className="summary-row__k">Thời gian</span><span className="summary-row__v">{formatClockVN(paidPayment.paidAt)}</span></div>
          </div>
        )}

        {returns.length > 0 && (
          <div className="card card--flat">
            <div className="section-title" style={{ marginTop: 0 }}>Trả hàng / Hoàn tiền</div>
            {returns.map((r) => (
              <div key={r.id} className="summary-row">
                <span className="summary-row__k">Hoàn {formatVnd(r.refundTotal)}</span>
                <span className="summary-row__v">
                  {r.status === "completed" ? "Đã hoàn" : r.status === "pending" ? "Chờ chuyển" : r.status}
                </span>
              </div>
            ))}
            {pendingRefund && (
              <ConfirmRefundButton refundId={pendingRefund.id} onDone={load} />
            )}
          </div>
        )}
      </div>

      <Sheet open={receiptOpen} onClose={() => setReceiptOpen(false)} title="Biên nhận">
        <iframe title="Biên nhận" className="receipt-frame" srcDoc={receiptHtml ?? ""} />
      </Sheet>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, { l: string; c: string }> = {
    paid: { l: "Đã thanh toán", c: "chip--good" },
    refunded: { l: "Đã hoàn toàn bộ", c: "chip--amber" },
    partially_refunded: { l: "Hoàn một phần", c: "chip--amber" },
    cancelled: { l: "Đã hủy", c: "" },
    awaiting_payment: { l: "Chờ thanh toán", c: "chip--teal" },
    draft: { l: "Nháp", c: "" },
  };
  const s = map[status] ?? { l: status, c: "" };
  return <span className={`chip ${s.c}`}>{s.l}</span>;
}

function ConfirmRefundButton({ refundId, onDone }: { refundId: string; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function confirm() {
    setBusy(true); setErr(null);
    try {
      const ref = prompt("Mã tham chiếu chuyển khoản (nếu có):", "") ?? undefined;
      await api.confirmRefund(refundId, ref);
      await onDone();
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Không xác nhận được."); }
    finally { setBusy(false); }
  }
  return (
    <>
      {err && <InlineError message={err} onClose={() => setErr(null)} />}
      <button className="btn btn--primary" style={{ marginTop: 10 }} disabled={busy} onClick={confirm}>
        {busy ? <span className="spinner spinner--sm spinner--light" /> : "Xác nhận đã chuyển tiền"}
      </button>
    </>
  );
}

// ── Trả hàng / Hoàn tiền ──────────────────────────────────────────────────────
function ReturnFlow({ view, onBack, onDone }: { view: OrderView; onBack: () => void; onDone: () => void }) {
  const { order, items } = view;
  const returns = (view.returns ?? []) as unknown as ReturnRow[];

  // already-returned qty per order item
  const priorQty = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of returns) for (const it of r.items ?? []) m.set(it.orderItemId, (m.get(it.orderItemId) ?? 0) + Number(it.quantity));
    return m;
  }, [returns]);

  const [sel, setSel] = useState<Record<string, { qty: number; condition: string }>>({});
  const [method, setMethod] = useState<"cash" | "bank_transfer">("cash");
  const [reason, setReason] = useState("customer_change");
  const [preview, setPreview] = useState<{ refundTotal: number; maxRefundable: number; canRefund: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idemKey = useMemo(() => newIdempotencyKey(), []);

  const remainingOf = (itemId: string, sold: number) => sold - (priorQty.get(itemId) ?? 0);

  function toggle(itemId: string, sold: number) {
    setSel((s) => {
      const next = { ...s };
      if (next[itemId]) delete next[itemId];
      else next[itemId] = { qty: Math.min(1, remainingOf(itemId, sold)), condition: "restockable" };
      return next;
    });
  }
  function setQty(itemId: string, qty: number, max: number) {
    setSel((s) => ({ ...s, [itemId]: { ...s[itemId], qty: Math.max(1, Math.min(max, qty)) } }));
  }
  function setCond(itemId: string, condition: string) {
    setSel((s) => ({ ...s, [itemId]: { ...s[itemId], condition } }));
  }

  const selItems = Object.entries(sel).map(([orderItemId, v]) => ({ orderItemId, quantity: v.qty, condition: v.condition }));

  useEffect(() => {
    if (selItems.length === 0) { setPreview(null); return; }
    let active = true;
    api.returnsPreview(order.id, selItems)
      .then((r) => { if (active) { setPreview(r); setError(null); } })
      .catch((e) => { if (active) setError(e instanceof ApiError ? e.message : "Không tính được số hoàn."); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(selItems), order.id]);

  async function submit() {
    if (selItems.length === 0 || busy) return;
    setBusy(true); setError(null);
    try {
      await api.createReturn(order.id, { items: selItems, reasonCode: reason, refundMethod: method }, idemKey);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tạo được phiếu trả.");
    } finally { setBusy(false); }
  }

  const actionLabel = method === "cash" ? "Xác nhận đã hoàn tiền" : "Lưu chờ xử lý";

  return (
    <div className="screen pos-screen">
      <div className="pos-top">
        <button className="step__back" onClick={onBack} aria-label="Quay lại">‹</button>
        <div className="pos-top__title">Trả hàng / Hoàn tiền</div>
        <span style={{ width: 40 }} />
      </div>
      <div className="pos-scroll">
        {error && <InlineError message={error} onClose={() => setError(null)} />}
        {items.length === 0 && <div className="muted tiny">Bill cũ không có chi tiết dòng để trả.</div>}

        {items.map((it) => {
          const remaining = remainingOf(it.id, Number(it.quantity));
          const chosen = sel[it.id];
          if (remaining <= 0) return null;
          return (
            <div key={it.id} className={`ret-line ${chosen ? "ret-line--on" : ""}`}>
              <label className="ret-line__head">
                <input type="checkbox" checked={!!chosen} onChange={() => toggle(it.id, Number(it.quantity))} />
                <span className="ret-line__name">{it.name}</span>
                <span className="muted tiny">còn {fmtQty(remaining)}</span>
              </label>
              {chosen && (
                <div className="ret-line__body">
                  <div className="cart-stepper">
                    <button onClick={() => setQty(it.id, chosen.qty - 1, remaining)} aria-label="Bớt"><IconMinus size={15} /></button>
                    <span>{fmtQty(chosen.qty)}</span>
                    <button onClick={() => setQty(it.id, chosen.qty + 1, remaining)} aria-label="Thêm"><IconPlus size={15} /></button>
                  </div>
                  <select className="input" value={chosen.condition} onChange={(e) => setCond(it.id, e.target.value)}>
                    <option value="restockable">Còn bán được (nhập lại kho)</option>
                    <option value="damaged">Lỗi / hỏng</option>
                    <option value="expired">Hết hạn</option>
                    <option value="other">Khác</option>
                  </select>
                </div>
              )}
            </div>
          );
        })}

        {selItems.length > 0 && (
          <>
            <div className="field" style={{ marginTop: 14 }}>
              <label className="field__label">Lý do trả</label>
              <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="customer_change">Khách đổi ý</option>
                <option value="defective">Lỗi sản phẩm</option>
                <option value="wrong_item">Giao sai hàng</option>
                <option value="other">Khác</option>
              </select>
            </div>
            <div className="field">
              <label className="field__label">Phương thức hoàn</label>
              <div className="segment">
                <button className={`segment__btn ${method === "cash" ? "segment__btn--on" : ""}`} onClick={() => setMethod("cash")}>Tiền mặt</button>
                <button className={`segment__btn ${method === "bank_transfer" ? "segment__btn--on" : ""}`} onClick={() => setMethod("bank_transfer")}>Chuyển khoản</button>
              </div>
            </div>
            <div className="card card--flat">
              <div className="summary-row summary-row--total"><span className="summary-row__k">Số tiền hoàn</span><span className="summary-row__v">{formatVnd(preview?.refundTotal ?? 0)}</span></div>
              <div className="muted tiny" style={{ marginTop: 4 }}>Tối đa có thể hoàn: {formatVnd(preview?.maxRefundable ?? 0)}</div>
            </div>
          </>
        )}
      </div>
      <div className="pos-foot">
        <button className="btn btn--primary" disabled={selItems.length === 0 || busy || !(preview?.canRefund)} onClick={submit}>
          {busy ? <span className="spinner spinner--sm spinner--light" /> : actionLabel}
        </button>
      </div>
    </div>
  );
}
