// Functional 11 — resolve a "Cần xem" item (spec 3.3 bổ sung → 3.5 xác nhận ghi).
// The user fills the missing fields (draft PATCH with If-Match row_version), the
// server recomputes a preview (verifying the source snapshot is unchanged), and
// only then can they commit an atomic, idempotent post. Excluding needs a reason.
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader, Button, SelectField, Banner } from "../components/ui";
import { Sheet, InlineError } from "../sales/ui";
import { useMerchant } from "../dashboard/MerchantContext";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import type { CashbookReviewItem, CashbookReviewPreview } from "../lib/api";
import { formatVnd } from "../lib/format";
import {
  ENTRY_TYPE_OPTIONS, METHOD_OPTIONS, METHOD_LABEL, entryTypeLabel,
  directionOfEntryType, EXCLUDE_REASON_OPTIONS,
} from "../lib/cashbook";
import { fmtDate, isoToLocalDate, localDateToIso } from "./parts";

export function ReviewItem() {
  const nav = useNavigate();
  const { id = "" } = useParams();
  const { merchant, role } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const canManage = role === "owner" || role === "manager";

  const [item, setItem] = useState<CashbookReviewItem | null>(null);
  const [entryType, setEntryType] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [method, setMethod] = useState("cash");
  const [step, setStep] = useState<"edit" | "confirm">("edit");
  const [preview, setPreview] = useState<CashbookReviewPreview | null>(null);
  const [idemKey, setIdemKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [excludeOpen, setExcludeOpen] = useState(false);

  const hydrate = useCallback((it: CashbookReviewItem) => {
    setItem(it);
    setEntryType(it.draft.entryType ?? "");
    setAmount(it.draft.amountVnd != null ? String(it.draft.amountVnd) : "");
    setDate(isoToLocalDate(it.draft.occurredAt));
    setMethod(it.draft.paymentMethod && it.draft.paymentMethod !== "unknown" ? it.draft.paymentMethod : "cash");
  }, []);

  const load = useCallback(async () => {
    if (!merchantId || !id) return;
    setError(null);
    try { const r = await api.cashbookGetReview(merchantId, id); hydrate(r.item); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Không tải được khoản cần xem."); }
  }, [merchantId, id, hydrate]);
  useEffect(() => { void load(); }, [load]);

  const amt = Math.trunc(Number(String(amount).replace(/[^\d]/g, "")));
  const valid = Boolean(entryType) && amt > 0 && Boolean(date) && Boolean(method);

  async function saveAndPreview() {
    if (!item || !valid || busy) return;
    setBusy(true); setError(null);
    try {
      const updated = await api.cashbookPatchReview(merchantId, item.id, {
        entryType, direction: directionOfEntryType(entryType) ?? undefined,
        amountVnd: amt, occurredAt: localDateToIso(date), paymentMethod: method as "cash" | "transfer" | "other",
        expectedRowVersion: item.rowVersion,
      });
      setItem(updated);
      const pv = await api.cashbookPreviewReview(merchantId, item.id);
      setPreview(pv); setIdemKey(newIdempotencyKey()); setStep("confirm");
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") { await load(); setError("Khoản này vừa thay đổi. Đã tải lại, vui lòng xem lại."); }
      else setError(e instanceof ApiError ? e.message : "Không xem trước được.");
    } finally { setBusy(false); }
  }

  async function post() {
    if (!item || !preview || busy) return;
    setBusy(true); setError(null);
    try {
      await api.cashbookPostReview(merchantId, item.id, { expectedRowVersion: preview.expectedRowVersion }, idemKey);
      nav("/so-quy", { replace: true });
    } catch (e) {
      if (e instanceof ApiError && (e.code === "VERSION_CONFLICT")) { await load(); setStep("edit"); setError("Dữ liệu vừa thay đổi. Vui lòng kiểm tra lại rồi ghi."); }
      else setError(e instanceof ApiError ? e.message : "Không ghi được vào sổ.");
    } finally { setBusy(false); }
  }

  if (!item) {
    return (
      <div className="screen">
        <PageHeader title="Cần xem" onBack={() => nav("/so-quy/can-xem")} />
        <div className="content--plain">{error ? <Banner kind="error">{error}</Banner> : <div className="muted" style={{ padding: 24, textAlign: "center" }}>Đang tải…</div>}</div>
      </div>
    );
  }

  return (
    <div className="screen">
      <PageHeader title={step === "edit" ? "Bổ sung thông tin" : "Xác nhận ghi sổ"} onBack={() => step === "confirm" ? setStep("edit") : nav("/so-quy/can-xem")} />
      <div className="content--plain cbk" style={{ paddingBottom: 96 }}>
        {error && <InlineError message={error} onClose={() => setError(null)} />}

        <div className="card card--flat cbk-src-card">
          <div className="cbk-src-card__row"><span className="muted tiny">Nguồn</span><b>{item.draft.sourceLabel || "Ghi tay"}</b></div>
          {item.draft.route && (
            <button className="btn btn--outline" style={{ marginTop: 8 }} onClick={() => nav(item.draft.route!)}>Xem nguồn</button>
          )}
          {item.reasons.length > 0 && (
            <div className="cbk-review-row__reasons" style={{ marginTop: 8 }}>
              {item.reasons.map((r) => <span key={r.code} className="chip chip--reason">{r.label}</span>)}
            </div>
          )}
        </div>

        {step === "edit" ? (
          <div className="stack" style={{ marginTop: 10 }}>
            <SelectField label="Loại khoản" value={entryType} onChange={setEntryType} required
              options={ENTRY_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
            <div className="field">
              <label className="field__label">Số tiền<span className="field__req"> *</span></label>
              <input className="input" inputMode="numeric" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="field">
              <label className="field__label">Ngày<span className="field__req"> *</span></label>
              <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <SelectField label="Phương thức" value={method} onChange={setMethod} required options={METHOD_OPTIONS} />
          </div>
        ) : preview ? (
          <div className="stack" style={{ marginTop: 10 }}>
            <div className="card card--flat cbk-preview">
              <div className="kv"><span>Chiều</span><b>{preview.preview.direction === "in" ? "Thu" : "Chi"}</b></div>
              <div className="kv"><span>Loại</span><b>{entryTypeLabel(preview.preview.entryType)}</b></div>
              <div className="kv"><span>Số tiền</span><b>{formatVnd(preview.preview.amountVnd)}</b></div>
              <div className="kv"><span>Ngày</span><b>{fmtDate(preview.preview.occurredAt)}</b></div>
              <div className="kv"><span>Phương thức</span><b>{METHOD_LABEL[preview.preview.paymentMethod]}</b></div>
            </div>
            <div className="muted tiny">Ghi vào sổ sẽ khóa nguồn này và cộng vào tổng kỳ. Không thể sửa sau khi ghi — chỉ có thể đảo.</div>
          </div>
        ) : null}
      </div>

      <div className="form-foot">
        {step === "edit" ? (
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn--outline" onClick={() => setExcludeOpen(true)} disabled={!canManage}>Không đưa vào sổ</button>
            <div style={{ flex: 1 }}>
              <Button variant="primary" loading={busy} disabled={!valid || !canManage}
                disabledReason={!canManage ? "Cần quyền quản lý." : !valid ? "Điền đủ loại, số tiền, ngày." : undefined}
                onClick={saveAndPreview}>Xem trước để ghi</Button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn--outline" onClick={() => setStep("edit")} style={{ flex: 1 }}>Sửa</button>
            <div style={{ flex: 1 }}>
              <Button variant="primary" loading={busy} onClick={post}>Ghi vào sổ</Button>
            </div>
          </div>
        )}
      </div>

      <ExcludeSheet open={excludeOpen} onClose={() => setExcludeOpen(false)} merchantId={merchantId}
        item={item} onDone={() => nav("/so-quy/can-xem", { replace: true })} />
    </div>
  );
}

function ExcludeSheet({
  open, onClose, merchantId, item, onDone,
}: {
  open: boolean; onClose: () => void; merchantId: string; item: CashbookReviewItem; onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!reason || busy) return;
    setBusy(true); setError(null);
    try {
      await api.cashbookExcludeReview(merchantId, item.id, { reasonCode: reason, note: note || undefined, expectedRowVersion: item.rowVersion });
      onDone();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Không loại được khoản."); }
    finally { setBusy(false); }
  }

  if (!open) return null;
  return (
    <Sheet open={open} onClose={onClose} title="Không đưa vào sổ">
      {error && <InlineError message={error} onClose={() => setError(null)} />}
      <div className="stack" style={{ marginTop: 4 }}>
        <div className="field">
          <label className="field__label">Lý do<span className="field__req"> *</span></label>
          <div className="seg-scroll" style={{ paddingLeft: 0 }}>
            {EXCLUDE_REASON_OPTIONS.map((o) => (
              <button key={o.value} className={`chip ${reason === o.value ? "chip--on" : ""}`} onClick={() => setReason(o.value)}>{o.label}</button>
            ))}
          </div>
        </div>
        <div className="field">
          <label className="field__label">Ghi chú <span className="field__opt">(không bắt buộc)</span></label>
          <textarea className="input" rows={2} placeholder="Ghi chú thêm…" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <Button variant="danger" loading={busy} disabled={!reason} onClick={submit}>Loại khỏi sổ</Button>
      </div>
    </Sheet>
  );
}
