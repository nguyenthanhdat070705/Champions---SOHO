// "Giỏ hàng" (spec 3.5): line edit/remove, per-line + order discount entry, and
// a server-computed totals block ("Đã cập nhật" badge). The Continue CTA locks
// the cart and moves to payment method. All money shown here comes from the
// server preview; the local estimate only fills the gap while it loads.
import { formatVnd } from "../lib/format";
import { IconBack, IconMinus, IconPlus, IconTrash } from "../components/icons";
import type { PreviewResult } from "../lib/api";
import type { CartState } from "./cartStore";
import { localEstimate } from "./cartStore";
import { InlineError } from "./ui";

function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n).replace(/\.?0+$/, "");
}

export function CartView({
  cart, preview, previewBusy, error, busy,
  onBack, onInc, onDec, onRemove, onSetNote, onLineDiscount, onOrderDiscount, onAddMore, onContinue, onClearError,
}: {
  cart: CartState;
  preview: PreviewResult | null;
  previewBusy: boolean;
  error: string | null;
  busy: boolean;
  onBack: () => void;
  onInc: (i: number) => void;
  onDec: (i: number) => void;
  onRemove: (i: number) => void;
  onSetQty: (i: number, q: number) => void;
  onSetNote: (i: number, note: string | null) => void;
  onLineDiscount: (i: number) => void;
  onOrderDiscount: () => void;
  onAddMore: () => void;
  onContinue: () => void;
  onClearError: () => void;
}) {
  const lines = cart.lines.filter((l) => l.quantity > 0);
  const subtotal = preview?.subtotalAmount ?? lines.reduce((a, l) => a + Math.round(l.unitPrice * l.quantity), 0);
  const discount = preview?.discountAmount ?? 0;
  const total = preview?.totalAmount ?? localEstimate(cart);
  const canCheckout = lines.length > 0 && total > 0 && !busy;

  return (
    <div className="screen pos-screen">
      <div className="pos-top">
        <button className="step__back" onClick={onBack} aria-label="Quay lại"><IconBack size={20} /></button>
        <div className="pos-top__title">Giỏ hàng ({lines.length})</div>
        <span style={{ width: 40 }} />
      </div>

      <div className="pos-scroll">
        {error && <InlineError message={error} onClose={onClearError} />}

        <div className="cart-lines">
          {cart.lines.map((l, i) => {
            if (l.quantity <= 0) return null;
            const gross = Math.round(l.unitPrice * l.quantity);
            return (
              <div key={(l.productId ?? "m") + i} className="cart-line">
                <div className="cart-line__main">
                  <div className="cart-line__name">{l.name}</div>
                  <div className="cart-line__meta">
                    {formatVnd(l.unitPrice)} · {l.unitCode}
                    {l.discount && <span className="chip chip--amber" style={{ marginLeft: 6 }}>Giảm giá</span>}
                  </div>
                  <div className="cart-line__actions">
                    {l.allowDiscount !== false && (
                      <button onClick={() => onLineDiscount(i)}>{l.discount ? "Sửa giảm giá" : "Giảm giá"}</button>
                    )}
                    <button onClick={() => { const n = prompt("Ghi chú dòng (tối đa 250 ký tự):", l.note ?? ""); if (n !== null) onSetNote(i, n.slice(0, 250) || null); }}>Ghi chú</button>
                    <button className="cart-line__del" onClick={() => onRemove(i)} aria-label="Xóa"><IconTrash size={16} /></button>
                  </div>
                </div>
                <div className="cart-line__right">
                  <div className="cart-line__amt">{formatVnd(gross)}</div>
                  <div className="cart-stepper">
                    <button onClick={() => onDec(i)} aria-label="Bớt"><IconMinus size={15} /></button>
                    <span>{fmtQty(l.quantity)}</span>
                    <button onClick={() => onInc(i)} aria-label="Thêm"><IconPlus size={15} /></button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <button className="btn btn--outline" style={{ marginTop: 6 }} onClick={onAddMore}>+ Thêm sản phẩm</button>

        <button className="cart-orderdisc" onClick={onOrderDiscount}>
          <span>Giảm giá toàn bill</span>
          <span className="cart-orderdisc__v">{cart.orderDiscount ? "Đã áp dụng" : "Thêm"}</span>
        </button>

        <div className="card card--flat cart-totals">
          <div className="cart-totals__head">
            <span className="section-title" style={{ margin: 0 }}>Tạm tính</span>
            {previewBusy ? <span className="chip chip--teal">Đang cập nhật…</span> : preview && <span className="chip chip--good">Đã cập nhật</span>}
          </div>
          <div className="summary-row"><span className="summary-row__k">Tổng hàng</span><span className="summary-row__v">{formatVnd(subtotal)}</span></div>
          {discount > 0 && <div className="summary-row"><span className="summary-row__k">Giảm giá</span><span className="summary-row__v">−{formatVnd(discount)}</span></div>}
          <div className="summary-row summary-row--total"><span className="summary-row__k">Tổng thanh toán</span><span className="summary-row__v">{formatVnd(total)}</span></div>
        </div>
      </div>

      <div className="pos-foot">
        <button className="btn btn--primary" disabled={!canCheckout} onClick={onContinue}>
          {busy ? <span className="spinner spinner--sm spinner--light" /> : `Tiếp tục thanh toán · ${formatVnd(total)}`}
        </button>
      </div>
    </div>
  );
}
