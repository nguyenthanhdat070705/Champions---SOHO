// Functional 11 — "Ghi tay" (spec 3.6). Captures a minimal draft (loại, số tiền,
// ngày, phương thức) and creates a review item; it NEVER auto-posts (FR-06). The
// user lands on the review item to preview and confirm. Voice/OCR are out of MVP
// scope — manual typing is the always-available path.
import { useState } from "react";
import { Sheet, InlineError } from "../sales/ui";
import { Button, SelectField } from "../components/ui";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import { ENTRY_TYPE_OPTIONS, METHOD_OPTIONS, directionOfEntryType } from "../lib/cashbook";
import { localDateToIso, isoToLocalDate } from "./parts";

export function ManualDraftSheet({
  open, onClose, merchantId, onCreated,
}: {
  open: boolean; onClose: () => void; merchantId: string; onCreated: (reviewId: string) => void;
}) {
  const [entryType, setEntryType] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(isoToLocalDate(new Date().toISOString()));
  const [method, setMethod] = useState("cash");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() { setEntryType(""); setAmount(""); setDate(isoToLocalDate(new Date().toISOString())); setMethod("cash"); setError(null); setBusy(false); }
  function close() { reset(); onClose(); }

  const amt = Math.trunc(Number(amount.replace(/[^\d]/g, "")));
  const valid = Boolean(entryType) && amt > 0 && Boolean(date);

  async function create() {
    if (!valid || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await api.cashbookManualDraft(merchantId, {
        entryType, direction: directionOfEntryType(entryType) ?? undefined,
        amountVnd: amt, occurredAt: localDateToIso(date), paymentMethod: method as "cash" | "transfer" | "other",
      }, newIdempotencyKey());
      reset();
      onCreated(res.reviewId);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tạo được bản nháp.");
    } finally { setBusy(false); }
  }

  if (!open) return null;
  return (
    <Sheet open={open} onClose={close} title="Ghi tay khoản thu / chi">
      {error && <InlineError message={error} onClose={() => setError(null)} />}
      <div className="stack" style={{ marginTop: 4 }}>
        <SelectField label="Loại khoản" value={entryType} onChange={setEntryType} required
          options={ENTRY_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
        <div className="field">
          <label className="field__label">Số tiền<span className="field__req"> *</span></label>
          <input className="input" inputMode="numeric" placeholder="0" value={amount}
            onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label">Ngày<span className="field__req"> *</span></label>
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <SelectField label="Phương thức" value={method} onChange={setMethod} options={METHOD_OPTIONS} />
        <div className="muted tiny">Bản nháp sẽ vào “Cần xem” để bạn kiểm tra và ghi vào sổ.</div>
        <Button variant="primary" loading={busy} disabled={!valid}
          disabledReason={!valid ? "Chọn loại, nhập số tiền và ngày." : undefined} onClick={create}>
          Tạo bản nháp
        </Button>
      </div>
    </Sheet>
  );
}
