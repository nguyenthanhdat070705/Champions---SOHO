// "Thanh toán tiền mặt" (spec 3.8): quick denomination chips + keypad, live
// change calc (client display only — the server validates), and a single
// idempotent finalize. The idempotency key is created once when the screen opens
// and reused across retries so a double-tap can never create a second payment
// (spec 11.4 / SALE-03). On timeout it re-reads canonical status before retry.
import { useMemo, useRef, useState } from "react";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import type { OrderView } from "../lib/api";
import { formatVnd } from "../lib/format";
import { IconBack } from "../components/icons";
import { Keypad, applyKey, InlineError } from "./ui";

const CHIPS = [10000, 20000, 50000, 100000, 200000, 500000];

export function CashPayment({
  merchantId, order, onBack, onPaid,
}: {
  merchantId: string;
  order: OrderView;
  onBack: () => void;
  onPaid: (changeDue: number) => void;
}) {
  const total = order.order.totalAmount;
  const [received, setReceived] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idemKey = useRef<string>(newIdempotencyKey());

  const receivedNum = Number(received || "0");
  const enough = receivedNum >= total;
  const change = Math.max(0, receivedNum - total);

  const chips = useMemo(() => CHIPS.filter((c) => c >= total).slice(0, 4), [total]);

  async function confirm() {
    if (!enough || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await api.payCash(
        { merchantId, orderId: order.order.id, expectedVersion: order.order.version, cashReceived: receivedNum },
        idemKey.current,
      );
      onPaid(res.changeDue);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === "PAYMENT_ALREADY_SUCCEEDED") { onPaid(change); return; }
        if (e.code === "PRICE_CHANGED") { setError("Giá đã thay đổi. Vui lòng quay lại giỏ và kiểm tra."); }
        else if (e.code === "VERSION_CONFLICT") { setError("Giỏ đã thay đổi ở nơi khác. Vui lòng làm lại."); }
        else if (e.code === "INSUFFICIENT_STOCK") { setError("Không đủ tồn kho. Vui lòng kiểm tra giỏ."); }
        else setError(e.message);
      } else setError("Có lỗi xảy ra. Vui lòng thử lại.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen pos-screen">
      <div className="pos-top">
        <button className="step__back" onClick={onBack} disabled={busy} aria-label="Quay lại"><IconBack size={20} /></button>
        <div className="pos-top__title">Tiền mặt</div>
        <span style={{ width: 40 }} />
      </div>

      <div className="pos-scroll">
        {error && <InlineError message={error} onClose={() => setError(null)} />}

        <div className="cash-due">
          <div className="cash-due__label">Khách cần trả</div>
          <div className="cash-due__value">{formatVnd(total)}</div>
        </div>

        <div className="cash-chips">
          <button className={`cash-chip ${receivedNum === total ? "cash-chip--on" : ""}`} onClick={() => setReceived(String(total))}>Đúng tiền</button>
          {chips.map((c) => (
            <button key={c} className={`cash-chip ${receivedNum === c ? "cash-chip--on" : ""}`} onClick={() => setReceived(String(c))}>{formatVnd(c)}</button>
          ))}
        </div>

        <div className="cash-input">
          <div className="cash-input__label">Tiền khách đưa</div>
          <div className={`cash-input__value ${received && !enough ? "cash-input__value--warn" : ""}`}>
            {received ? formatVnd(receivedNum) : <span className="muted">0đ</span>}
          </div>
          {received && !enough && <div className="field__error">Cần ≥ {formatVnd(total)}</div>}
        </div>

        <div className="cash-change">
          <span>Tiền thối</span>
          <span className="cash-change__v">{formatVnd(change)}</span>
        </div>

        <Keypad onKey={(k) => setReceived((r) => applyKey(r, k))} />
      </div>

      <div className="pos-foot">
        <button className="btn btn--primary" disabled={!enough || busy} onClick={confirm}>
          {busy ? <span className="spinner spinner--sm spinner--light" /> : "Xác nhận đã nhận tiền"}
        </button>
      </div>
    </div>
  );
}
