// "Thanh toán QR" (spec 3.9 / 5.2 / 5.3): backend creates the PayOS request, the
// screen only renders what the provider returns, and ONLY a webhook-confirmed
// status marks the bill paid — the returnUrl / "Đã chuyển khoản" button never
// does (it just re-reads canonical status via server reconcile). Countdown +
// poll + cancel + regenerate follow the payment state machine.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import type { OrderView } from "../lib/api";
import { formatVnd } from "../lib/format";
import { IconBack } from "../components/icons";
import { QrImage, InlineError } from "./ui";

type Phase = "creating" | "pending" | "expired" | "error";

export function QrPayment({
  merchantId, order, onBack, onCancelled, onPaid,
}: {
  merchantId: string;
  order: OrderView;
  onBack: () => void;
  onCancelled: () => void;
  onPaid: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("creating");
  const [payment, setPayment] = useState<{ paymentId: string; qrPayload: string | null; expiresAt: string | null; accountName?: string | null; accountMasked?: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number>(0);
  const [confirming, setConfirming] = useState(false);
  const idemKey = useRef<string>(newIdempotencyKey());
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const create = useCallback(async () => {
    setPhase("creating"); setError(null);
    idemKey.current = newIdempotencyKey();
    try {
      const res = await api.createQr({ merchantId, orderId: order.order.id, expectedVersion: order.order.version }, idemKey.current);
      setPayment(res);
      setPhase(res.status === "pending" ? "pending" : "pending");
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === "QR_CONNECTION_UNAVAILABLE") setError("Kết nối QR chưa sẵn sàng. Hãy chọn tiền mặt.");
        else if (e.code === "PAYMENT_ALREADY_SUCCEEDED") { onPaid(); return; }
        else setError(e.message);
      } else setError("Không tạo được mã QR.");
      setPhase("error");
    }
  }, [merchantId, order.order.id, order.order.version, onPaid]);

  useEffect(() => { void create(); }, [create]);

  // countdown
  useEffect(() => {
    if (phase !== "pending" || !payment?.expiresAt) return;
    const end = new Date(payment.expiresAt).getTime();
    const tick = () => {
      const secs = Math.max(0, Math.round((end - Date.now()) / 1000));
      setRemaining(secs);
      if (secs <= 0) setPhase("expired");
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [phase, payment?.expiresAt]);

  // poll canonical status (webhook-confirmed source of truth)
  useEffect(() => {
    if (phase !== "pending" || !payment) return;
    pollTimer.current = setInterval(async () => {
      try {
        const st = await api.getPayment(payment.paymentId);
        if (st.status === "succeeded") { onPaid(); }
        else if (st.status === "expired") setPhase("expired");
        else if (st.status === "cancelled") onCancelled();
      } catch { /* keep polling */ }
    }, 3000);
    return () => { if (pollTimer.current) clearInterval(pollTimer.current); };
  }, [phase, payment, onPaid, onCancelled]);

  async function checkNow() {
    if (!payment || confirming) return;
    setConfirming(true);
    try {
      const st = await api.getPayment(payment.paymentId, true); // server-to-server reconcile
      if (st.status === "succeeded") onPaid();
      else setError("Chưa nhận được xác nhận. Vui lòng đợi khách hoàn tất chuyển khoản.");
    } catch { setError("Không kiểm tra được trạng thái."); }
    finally { setConfirming(false); }
  }

  async function cancel() {
    if (!payment) { onCancelled(); return; }
    if (!confirm("Hủy mã QR này?")) return;
    try {
      const res = await api.cancelPayment(payment.paymentId, "user_cancel");
      if (res.status === "succeeded") { onPaid(); return; } // paid won the race
      onCancelled();
    } catch (e) {
      if (e instanceof ApiError && e.code === "PAYMENT_ALREADY_SUCCEEDED") { onPaid(); return; }
      onCancelled();
    }
  }

  const mm = Math.floor(remaining / 60), ss = remaining % 60;

  return (
    <div className="screen pos-screen">
      <div className="pos-top">
        <button className="step__back" onClick={cancel} aria-label="Hủy"><IconBack size={20} /></button>
        <div className="pos-top__title">Quét QR để trả</div>
        <span style={{ width: 40 }} />
      </div>

      <div className="pos-scroll" style={{ textAlign: "center" }}>
        {error && <InlineError message={error} onClose={() => setError(null)} />}

        {phase === "creating" && <div className="qr-loading"><div className="spinner" /><div className="muted" style={{ marginTop: 12 }}>Đang tạo mã QR…</div></div>}

        {phase === "pending" && payment?.qrPayload && (
          <>
            <div className="qr-card">
              <QrImage payload={payment.qrPayload} size={230} />
            </div>
            <div className="qr-amount">{formatVnd(order.order.totalAmount)}</div>
            {payment.accountName && <div className="muted tiny">Tài khoản nhận: {payment.accountName}{payment.accountMasked ? ` · ${payment.accountMasked}` : ""}</div>}
            <div className="qr-status">
              <span className="qr-status__dot" /> Đang chờ thanh toán {remaining > 0 && <b>· {mm}:{String(ss).padStart(2, "0")}</b>}
            </div>
            <button className="btn btn--outline" style={{ marginTop: 14 }} disabled={confirming} onClick={checkNow}>
              {confirming ? <span className="spinner spinner--sm" /> : "Tôi đã chuyển khoản"}
            </button>
            <button className="btn btn--danger" style={{ marginTop: 10 }} onClick={cancel}>Hủy thanh toán</button>
          </>
        )}

        {phase === "expired" && (
          <div className="qr-loading">
            <div className="empty__t">Mã QR đã hết hạn</div>
            <div className="empty__d" style={{ marginBottom: 14 }}>Chưa ghi nhận doanh thu. Tạo mã mới hoặc chọn tiền mặt.</div>
            <button className="btn btn--primary" onClick={create}>Tạo mã QR mới</button>
            <button className="btn btn--outline" style={{ marginTop: 10 }} onClick={onCancelled}>Chọn phương thức khác</button>
          </div>
        )}

        {phase === "error" && (
          <div className="qr-loading">
            <div className="empty__t">Không tạo được mã QR</div>
            <button className="btn btn--primary" style={{ marginTop: 12 }} onClick={create}>Thử lại</button>
            <button className="btn btn--outline" style={{ marginTop: 10 }} onClick={onBack}>Chọn tiền mặt</button>
          </div>
        )}
      </div>
    </div>
  );
}
