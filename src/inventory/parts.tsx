// Functional 05 shared UI: stock-state badge, reason picker, and the "Điều chỉnh
// nhanh" sheet (spec 3.3 → 3.4: form → server preview → confirm). The sheet owns
// the whole two-step flow so both the overview and the ledger can reuse it. A 409
// INVENTORY_BALANCE_CHANGED reloads the preview and asks the user to re-confirm
// (spec 3.4); negative stock is blocked (INSUFFICIENT_STOCK).
import { useState } from "react";
import { Sheet, InlineError } from "../sales/ui";
import { Button } from "../components/ui";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import type { AdjustPreview, StockState } from "../lib/api";
import {
  reasonOptionsFor, reasonComplete, REASON_LABEL, STATE_LABEL,
  fmtQty, parseQty,
} from "../lib/inventory";
import { unitLabel } from "../lib/catalog";

export function StateBadge({ state }: { state: StockState }) {
  if (state === "ok") return null;
  const cls = state === "low" ? "pill--low" : "pill--out";
  return <span className={`pill ${cls}`}>{STATE_LABEL[state]}</span>;
}

export interface AdjustTarget { productId: string; name: string; unitCode: string; onHand: number; }

/** The two-step manual-adjustment sheet. `onDone` fires after a successful post. */
export function AdjustSheet({
  open, onClose, merchantId, target, onDone,
}: {
  open: boolean;
  onClose: () => void;
  merchantId: string;
  target: AdjustTarget | null;
  onDone: () => void;
}) {
  const [direction, setDirection] = useState<"increase" | "decrease">("decrease");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState<string>("");
  const [note, setNote] = useState("");
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [preview, setPreview] = useState<AdjustPreview | null>(null);
  const [idemKey, setIdemKey] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setDirection("decrease"); setQty(""); setReason(""); setNote("");
    setStep("form"); setPreview(null); setIdemKey(""); setError(null); setBusy(false);
  }
  function close() { reset(); onClose(); }

  const parsedQty = parseQty(qty);
  const reasonOk = reasonComplete(reason, note);
  const formValid = parsedQty != null && parsedQty > 0 && reasonOk && Boolean(target);

  async function goConfirm() {
    if (!target || !formValid || busy) return;
    setBusy(true); setError(null);
    try {
      const p = await api.adjustPreview(merchantId, {
        productId: target.productId, direction, quantity: parsedQty as number,
        reasonCode: reason, note: note || undefined,
      });
      setPreview(p);
      setIdemKey(newIdempotencyKey());
      setStep("confirm");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không xem trước được.");
    } finally { setBusy(false); }
  }

  async function confirm() {
    if (!target || !preview || busy) return;
    setBusy(true); setError(null);
    try {
      await api.adjustPost(merchantId, {
        productId: target.productId, direction, quantity: preview.quantity,
        reasonCode: reason, note: note || undefined, expectedBalanceVersion: preview.currentVersion,
      }, idemKey);
      reset();
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === "INVENTORY_BALANCE_CHANGED") {
        // Reload the preview against the current balance and ask to re-confirm.
        const cur = (e.details as { current?: { onHand: number; rowVersion: number } })?.current;
        try {
          const p = await api.adjustPreview(merchantId, {
            productId: target.productId, direction, quantity: preview.quantity, reasonCode: reason, note: note || undefined,
          });
          setPreview(p);
          setIdemKey(newIdempotencyKey());
          setError(`Số tồn vừa thay đổi (còn ${fmtQty(cur?.onHand ?? p.before)}). Vui lòng kiểm tra lại rồi xác nhận.`);
        } catch { setError("Số tồn vừa thay đổi. Vui lòng thử lại."); }
      } else {
        setError(e instanceof ApiError ? e.message : "Không lưu được điều chỉnh.");
      }
    } finally { setBusy(false); }
  }

  if (!open || !target) return null;
  const unit = unitLabel(target.unitCode);
  const reasonOptions = reasonOptionsFor(direction);

  return (
    <Sheet open={open} onClose={close} title={step === "form" ? "Điều chỉnh tồn" : "Xác nhận điều chỉnh"}>
      {error && <InlineError message={error} onClose={() => setError(null)} />}
      <div className="inv-adjust__head">
        <div className="inv-adjust__name">{target.name}</div>
        <div className="muted tiny">Tồn hiện có: <b>{fmtQty(target.onHand)}</b> {unit}</div>
      </div>

      {step === "form" ? (
        <div className="stack" style={{ marginTop: 8 }}>
          <div className="segment">
            <button className={`segment__btn ${direction === "increase" ? "segment__btn--on" : ""}`}
              onClick={() => { setDirection("increase"); setReason(""); }}>Tăng (+)</button>
            <button className={`segment__btn ${direction === "decrease" ? "segment__btn--on" : ""}`}
              onClick={() => { setDirection("decrease"); setReason(""); }}>Giảm (−)</button>
          </div>

          <div className="field">
            <label className="field__label">Số lượng<span className="field__req"> *</span></label>
            <input className="input" inputMode="decimal" placeholder="0" value={qty}
              onChange={(e) => setQty(e.target.value)} />
            {qty !== "" && parsedQty == null && <div className="field__error">Nhập số lượng hợp lệ (&gt; 0).</div>}
          </div>

          <div className="field">
            <label className="field__label">Lý do<span className="field__req"> *</span></label>
            <div className="seg-scroll" style={{ paddingLeft: 0 }}>
              {reasonOptions.map((o) => (
                <button key={o.value} className={`chip ${reason === o.value ? "chip--on" : ""}`}
                  onClick={() => setReason(o.value)}>{o.label}</button>
              ))}
            </div>
          </div>

          {reason === "OTHER" && (
            <div className="field">
              <label className="field__label">Ghi chú<span className="field__req"> *</span></label>
              <textarea className="input" rows={2} placeholder="Mô tả lý do…" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          )}
          {reason && reason !== "OTHER" && (
            <div className="field">
              <label className="field__label">Ghi chú <span className="field__opt">(không bắt buộc)</span></label>
              <textarea className="input" rows={2} placeholder="Thêm ghi chú…" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          )}

          <Button variant="primary" loading={busy} disabled={!formValid}
            disabledReason={!formValid ? "Nhập số lượng và chọn lý do." : undefined} onClick={goConfirm}>
            Tiếp tục
          </Button>
        </div>
      ) : preview ? (
        <div className="stack" style={{ marginTop: 8 }}>
          <div className="card card--flat inv-adjust__ba">
            <div className="inv-adjust__ba-col"><div className="muted tiny">Trước</div><div className="inv-adjust__ba-num">{fmtQty(preview.before)}</div></div>
            <div className="inv-adjust__ba-arrow">{direction === "increase" ? "▲" : "▼"} {fmtQty(Math.abs(preview.delta))}</div>
            <div className="inv-adjust__ba-col"><div className="muted tiny">Sau</div><div className={`inv-adjust__ba-num ${preview.wouldBlock ? "inv-adjust__ba-num--bad" : ""}`}>{fmtQty(preview.after)}</div></div>
          </div>
          <div className="kv"><span>Lý do</span><b>{REASON_LABEL[reason] ?? reason}</b></div>
          {note && <div className="kv"><span>Ghi chú</span><b>{note}</b></div>}
          {preview.wouldBlock && <InlineError message="Không đủ hàng để giảm xuống dưới 0." />}
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn--outline" onClick={() => setStep("form")} style={{ flex: 1 }}>Sửa</button>
            <div style={{ flex: 1 }}>
              <Button variant="primary" loading={busy} disabled={preview.wouldBlock} onClick={confirm}>Xác nhận</Button>
            </div>
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}
