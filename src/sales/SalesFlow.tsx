// The Functional 03 golden flow (spec §2): chọn hàng → giỏ hàng → chọn phương
// thức → tiền mặt / QR → thành công. Implemented as one full-screen multi-step
// component so the cart survives back-navigation between steps and a single
// device draft is persisted to localStorage (FR-01). The server computes ALL
// totals and is the only thing that marks a bill paid (FR-04 / spec 5.2).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMerchant } from "../dashboard/MerchantContext";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import type { ApiProduct, OrderView, PreviewResult } from "../lib/api";
import {
  addProduct, decLine, emptyCart, incLine, isEmpty, localEstimate, removeLine,
  setLineDiscount, setLineNote, setOrderDiscount, setQuantity, toApiPayload, totalQuantity,
} from "./cartStore";
import type { CartState, LineDiscount } from "./cartStore";
import { proceedDecision, canLockCreated } from "../lib/checkout";
import { formatVnd } from "../lib/format";
import { useUndoToast, Sheet } from "./ui";
import { QuickCreateSheet, ScanSheet, DiscountSheet } from "./sheets";
import { ProductPicker } from "./ProductPicker";
import { CartView } from "./CartView";
import { PaymentMethod } from "./PaymentMethod";
import { CashPayment } from "./CashPayment";
import { QrPayment } from "./QrPayment";
import { SuccessView } from "./SuccessView";

type Step = "pick" | "cart" | "method" | "cash" | "qr" | "success";

function draftKey(merchantId: string) {
  return `soho-pos:v1:${merchantId}`;
}

interface Persisted {
  clientRequestId: string;
  cart: CartState;
}

export function SalesFlow() {
  const nav = useNavigate();
  const { merchant } = useMerchant();
  const merchantId = merchant?.id ?? "";

  const [step, setStep] = useState<Step>("pick");
  const [cart, setCart] = useState<CartState>(emptyCart);
  const [clientRequestId, setClientRequestId] = useState<string>(() => newIdempotencyKey());
  const [order, setOrder] = useState<OrderView | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ orderId: string; total: number; method: string; changeDue: number } | null>(null);
  // An unpaid bill still sitting at awaiting_payment when the cashier presses
  // "Tiếp tục" on a DIFFERENT cart → we surface an explicit choice instead of
  // silently reusing it (the F3 stale-payment hotfix). `keepCartAfterPay` is set
  // when the cashier chooses to pay that older bill first, so paying it does NOT
  // wipe the current cart draft.
  const [outstanding, setOutstanding] = useState<OrderView | null>(null);
  const [keepCartAfterPay, setKeepCartAfterPay] = useState(false);

  // sheets
  const [scanOpen, setScanOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickBarcode, setQuickBarcode] = useState<string | undefined>();
  const [discountTarget, setDiscountTarget] = useState<number | "order" | null>(null);

  const undo = useUndoToast();
  const previewSeq = useRef(0);

  // ── draft persistence (one active draft per device) ────────────────────────
  useEffect(() => {
    if (!merchantId) return;
    try {
      const raw = localStorage.getItem(draftKey(merchantId));
      if (raw) {
        const p = JSON.parse(raw) as Persisted;
        if (p?.cart?.lines?.length) {
          setCart(p.cart);
          setClientRequestId(p.clientRequestId || newIdempotencyKey());
        }
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchantId]);

  useEffect(() => {
    if (!merchantId) return;
    try {
      if (isEmpty(cart)) localStorage.removeItem(draftKey(merchantId));
      else localStorage.setItem(draftKey(merchantId), JSON.stringify({ clientRequestId, cart }));
    } catch { /* ignore */ }
  }, [merchantId, cart, clientRequestId]);

  // ── debounced server preview (authoritative totals) ────────────────────────
  const runPreview = useCallback(async (state: CartState) => {
    if (!merchantId || isEmpty(state)) { setPreview(null); return; }
    const seq = ++previewSeq.current;
    setPreviewBusy(true);
    try {
      const { items, adjustments } = toApiPayload(state);
      const res = await api.preview(merchantId, { items, adjustments });
      if (seq === previewSeq.current) { setPreview(res); setError(null); }
    } catch (e) {
      if (seq === previewSeq.current) {
        const msg = e instanceof ApiError ? e.message : "Không tính được tổng tiền.";
        setError(msg);
      }
    } finally {
      if (seq === previewSeq.current) setPreviewBusy(false);
    }
  }, [merchantId]);

  useEffect(() => {
    const t = setTimeout(() => void runPreview(cart), 280);
    return () => clearTimeout(t);
  }, [cart, runPreview]);

  const estimate = useMemo(() => localEstimate(cart), [cart]);
  const displayTotal = preview?.totalAmount ?? estimate;

  // ── cart mutations ─────────────────────────────────────────────────────────
  const onAdd = (p: ApiProduct) => setCart((c) => addProduct(c, p));
  const onInc = (i: number) => setCart((c) => incLine(c, i));
  const onDec = (i: number) => setCart((c) => {
    const line = c.lines[i];
    if (line && line.quantity <= 1) {
      const removed = line;
      undo.show(`Đã xóa ${removed.name}`, () => setCart((cur) => ({ ...cur, lines: [...cur.lines, removed] })));
      return removeLine(c, i);
    }
    return decLine(c, i);
  });
  const onRemove = (i: number) => setCart((c) => {
    const removed = c.lines[i];
    undo.show(`Đã xóa ${removed?.name ?? "dòng"}`, () => setCart((cur) => ({ ...cur, lines: [...cur.lines, removed] })));
    return removeLine(c, i);
  });
  const onSetQty = (i: number, q: number) => setCart((c) => setQuantity(c, i, q));
  const onSetNote = (i: number, note: string | null) => setCart((c) => setLineNote(c, i, note));

  const applyDiscount = (d: LineDiscount | null) => {
    if (discountTarget === "order") setCart((c) => setOrderDiscount(c, d));
    else if (typeof discountTarget === "number") setCart((c) => setLineDiscount(c, discountTarget, d));
    setDiscountTarget(null);
  };

  const clearCart = () => { setCart(emptyCart()); setPreview(null); setOrder(null); setClientRequestId(newIdempotencyKey()); };

  // ── checkout: create/update draft on server + lock (reserve stock) ─────────
  // Lock the CURRENT cart as its own fresh bill and go to the payment screen.
  // `reqId` lets a caller force a brand-new client_request_id so the server's
  // idempotent createOrder builds a NEW order from the current cart instead of
  // replaying an older order bound to a reused id (the stale-payment bug).
  async function lockCurrentCart(reqId: string = clientRequestId) {
    const { items, adjustments } = toApiPayload(cart);
    let ord = order;
    if (!ord || ord.order.status !== "draft") {
      ord = await api.createOrder(merchantId, { clientRequestId: reqId, items, adjustments, note: cart.note });
    } else {
      ord = await api.updateOrder(ord.order.id, { expectedVersion: ord.order.version, items, adjustments, note: cart.note });
    }
    // Guard: createOrder may idempotently replay a non-draft order (reused id).
    // Never proceed to payment on such an order — surface it as an outstanding
    // bill so the cashier decides explicitly.
    if (!canLockCreated(ord.order.status)) { setOutstanding(ord); return; }
    if (reqId !== clientRequestId) setClientRequestId(reqId);
    const locked = await api.lockOrder(ord.order.id, ord.order.version);
    setOrder(locked);
    setStep("method");
  }

  async function proceedToPayment() {
    if (!merchantId || isEmpty(cart)) return;
    setBusy(true); setError(null);
    try {
      // Is another bill for this cashier still awaiting payment? If so, don't
      // silently reuse it — ask what to do (spec: explicit choice, no auto-cancel).
      const res = await api.outstandingBill(merchantId, order?.order.id);
      if (res.order && proceedDecision(res.order.id, order?.order.id) === "show-dialog") {
        setOutstanding(res); setBusy(false); return;
      }
      await lockCurrentCart();
    } catch (e) {
      handleCheckoutError(e);
    } finally {
      setBusy(false);
    }
  }

  // Dialog action: pay the older outstanding bill first. Keep the current cart
  // draft intact (give it a fresh client_request_id so it decouples from the
  // bill we're about to pay), navigate straight to that bill's payment screen.
  function payOutstandingBill() {
    if (!outstanding) return;
    const paid = outstanding;
    setOutstanding(null);
    setClientRequestId(newIdempotencyKey());
    setKeepCartAfterPay(true);
    setOrder(paid);
    setError(null);
    setStep("method");
  }

  // Dialog action: cancel the stale bill (releases its reservations via the
  // existing cancel endpoint), then lock the current cart under a FRESH id.
  async function cancelOutstandingAndContinue() {
    if (!outstanding) return;
    const stale = outstanding;
    setOutstanding(null);
    setBusy(true); setError(null);
    try {
      await api.cancelOrder(stale.order.id, stale.order.version);
      await lockCurrentCart(newIdempotencyKey());
    } catch (e) {
      handleCheckoutError(e);
    } finally {
      setBusy(false);
    }
  }

  function handleCheckoutError(e: unknown) {
    if (e instanceof ApiError) {
      if (e.code === "PRICE_CHANGED") {
        setError("Giá đã thay đổi. Đã cập nhật lại tổng tiền, vui lòng kiểm tra.");
        void runPreview(cart);
        setStep("cart");
        return;
      }
      if (e.code === "INSUFFICIENT_STOCK") { setError("Không đủ tồn kho cho một sản phẩm. Vui lòng giảm số lượng."); setStep("cart"); return; }
      if (e.code === "VERSION_CONFLICT") { setError("Giỏ đã thay đổi. Vui lòng thử lại."); return; }
      setError(e.message);
      return;
    }
    setError("Có lỗi xảy ra. Vui lòng thử lại.");
  }

  async function backFromMethod() {
    setKeepCartAfterPay(false);
    if (order) {
      try { const un = await api.unlockOrder(order.order.id, order.order.version); setOrder(un); }
      catch { /* a pending QR keeps it locked; stay consistent and just go back */ }
    }
    setStep("cart");
  }

  function onPaid(info: { orderId: string; total: number; method: string; changeDue: number }) {
    setSuccess(info);
    if (keepCartAfterPay) {
      // We just paid an older outstanding bill — the current cart is a separate,
      // intact draft; leave it (and its fresh id) alone, only drop the paid order.
      setKeepCartAfterPay(false);
      setOrder(null);
    } else {
      clearCart();
    }
    setStep("success");
  }

  if (!merchantId) {
    return <div className="center-screen"><div className="empty"><div className="empty__t">Chưa có cửa hàng</div></div></div>;
  }

  return (
    <>
      {step === "pick" && (
        <ProductPicker
          merchantId={merchantId}
          cart={cart}
          total={displayTotal}
          count={totalQuantity(cart)}
          previewBusy={previewBusy}
          onAdd={onAdd}
          onInc={onInc}
          onDec={onDec}
          onClose={() => nav("/")}
          onOpenScan={() => setScanOpen(true)}
          onOpenQuick={(barcode) => { setQuickBarcode(barcode); setQuickOpen(true); }}
          onViewCart={() => setStep("cart")}
          onClear={clearCart}
        />
      )}

      {step === "cart" && (
        <CartView
          cart={cart}
          preview={preview}
          previewBusy={previewBusy}
          error={error}
          busy={busy}
          onBack={() => { setError(null); setStep("pick"); }}
          onInc={onInc}
          onDec={onDec}
          onRemove={onRemove}
          onSetQty={onSetQty}
          onSetNote={onSetNote}
          onLineDiscount={(i) => setDiscountTarget(i)}
          onOrderDiscount={() => setDiscountTarget("order")}
          onAddMore={() => setStep("pick")}
          onContinue={proceedToPayment}
          onClearError={() => setError(null)}
        />
      )}

      {step === "method" && order && (
        <PaymentMethod
          total={order.order.totalAmount}
          onBack={backFromMethod}
          onCash={() => setStep("cash")}
          onQr={() => setStep("qr")}
        />
      )}

      {step === "cash" && order && (
        <CashPayment
          merchantId={merchantId}
          order={order}
          onBack={() => setStep("method")}
          onPaid={(changeDue) => onPaid({ orderId: order.order.id, total: order.order.totalAmount, method: "cash", changeDue })}
        />
      )}

      {step === "qr" && order && (
        <QrPayment
          merchantId={merchantId}
          order={order}
          onBack={backFromMethod}
          onCancelled={() => setStep("method")}
          onPaid={() => onPaid({ orderId: order.order.id, total: order.order.totalAmount, method: "qr", changeDue: 0 })}
        />
      )}

      {step === "success" && success && (
        <SuccessView
          info={success}
          onNewBill={() => { setSuccess(null); setStep("pick"); }}
          onHome={() => nav("/")}
        />
      )}

      <ScanSheet
        open={scanOpen}
        merchantId={merchantId}
        onClose={() => setScanOpen(false)}
        onFound={(p) => { onAdd(p); }}
        onNotFound={(barcode) => { setScanOpen(false); setQuickBarcode(barcode); setQuickOpen(true); }}
      />

      <QuickCreateSheet
        open={quickOpen}
        merchantId={merchantId}
        initialBarcode={quickBarcode}
        onClose={() => { setQuickOpen(false); setQuickBarcode(undefined); }}
        onCreated={(p) => { onAdd(p); setQuickOpen(false); setQuickBarcode(undefined); }}
      />

      <DiscountSheet
        open={discountTarget !== null}
        scope={discountTarget === "order" ? "order" : "line"}
        current={discountTarget === "order" ? cart.orderDiscount ?? null : (typeof discountTarget === "number" ? cart.lines[discountTarget]?.discount ?? null : null)}
        base={discountTarget === "order" ? (preview?.subtotalAmount ?? estimate) : (typeof discountTarget === "number" ? Math.round((cart.lines[discountTarget]?.unitPrice ?? 0) * (cart.lines[discountTarget]?.quantity ?? 0)) : 0)}
        onClose={() => setDiscountTarget(null)}
        onApply={applyDiscount}
      />

      <Sheet
        open={outstanding !== null}
        onClose={() => setOutstanding(null)}
        title="Còn bill chưa thanh toán"
        footer={
          <div className="pay-choice__actions">
            <button className="btn btn--primary" disabled={busy} onClick={payOutstandingBill}>
              Thanh toán bill đó
            </button>
            <button className="btn btn--danger" disabled={busy} onClick={cancelOutstandingAndContinue}>
              {busy ? <span className="spinner spinner--sm" /> : "Hủy bill đó & tiếp tục giỏ mới"}
            </button>
          </div>
        }
      >
        {outstanding && (
          <div className="pay-choice">
            <p className="pay-choice__lead">
              Bạn còn bill <b>{outstanding.order.orderNumber}</b> chưa thanh toán:
            </p>
            <div className="pay-choice__amt">{formatVnd(outstanding.order.totalAmount)}</div>
            <p className="pay-choice__hint">
              Chọn thanh toán bill cũ trước, hoặc hủy nó để tiếp tục với giỏ hàng hiện tại.
            </p>
          </div>
        )}
      </Sheet>

      {undo.node}
    </>
  );
}
