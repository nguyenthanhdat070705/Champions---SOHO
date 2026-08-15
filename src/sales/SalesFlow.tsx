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
import { useUndoToast } from "./ui";
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
  async function proceedToPayment() {
    if (!merchantId || isEmpty(cart)) return;
    setBusy(true); setError(null);
    try {
      const { items, adjustments } = toApiPayload(cart);
      let ord = order;
      if (!ord) {
        ord = await api.createOrder(merchantId, { clientRequestId, items, adjustments, note: cart.note });
      } else {
        ord = await api.updateOrder(ord.order.id, { expectedVersion: ord.order.version, items, adjustments, note: cart.note });
      }
      const locked = await api.lockOrder(ord.order.id, ord.order.version);
      setOrder(locked);
      setStep("method");
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
    if (order) {
      try { const un = await api.unlockOrder(order.order.id, order.order.version); setOrder(un); }
      catch { /* a pending QR keeps it locked; stay consistent and just go back */ }
    }
    setStep("cart");
  }

  function onPaid(info: { orderId: string; total: number; method: string; changeDue: number }) {
    setSuccess(info);
    clearCart();
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

      {undo.node}
    </>
  );
}
