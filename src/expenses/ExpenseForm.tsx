// Functional 07 — "Ghi khoản chi" quick form (spec 3.2–3.7 folded into one fast
// flow). Optional receipt photo → Gemini draft pre-fills the fields, but the
// commit point is always this review screen (spec 1: "Chụp/Nói chỉ tạo bản nháp").
// The server owns every total; this only collects intent. Post is a create-draft
// then atomic post; a near-duplicate opens the review sheet (proceed allowed).
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader, Button } from "../components/ui";
import { InlineError } from "../sales/ui";
import { IconCamera, IconPlus, IconTrash, IconSparkle } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import type { ExpenseCategory, PaymentMethod, CreateExpenseItemInput } from "../lib/api";
import { formatVnd } from "../lib/format";
import { parseVnd, groupVnd, today, matchCategoryCandidate } from "../lib/expenses";
import { fileToBase64 } from "../catalog/parts";
import { CategoryChips, PaymentPicker, DuplicateSheet } from "./parts";
import type { DuplicateCandidate } from "./parts";

interface LineDraft { description: string; qty: string; unitCost: string; }

export function ExpenseForm() {
  const nav = useNavigate();
  const { merchant } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const fileRef = useRef<HTMLInputElement>(null);

  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [amount, setAmount] = useState("");
  const [expenseDate, setExpenseDate] = useState(today());
  const [payee, setPayee] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [confirmed, setConfirmed] = useState(false);
  const [items, setItems] = useState<LineDraft[]>([]);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const [ocrBusy, setOcrBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Create-draft idempotency key is stable for the life of this form attempt.
  const [createKey] = useState(() => newIdempotencyKey());
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftVersion, setDraftVersion] = useState(1);

  const [dupCandidates, setDupCandidates] = useState<DuplicateCandidate[] | null>(null);

  useEffect(() => {
    if (!merchantId) return;
    api.expenseCategories(merchantId).then((r) => setCategories(r.categories)).catch(() => setCategories([]));
  }, [merchantId]);

  const lineMode = items.length > 0;
  const lineSum = items.reduce((s, it) => {
    const q = Number(String(it.qty).replace(",", ".")) || 0;
    const u = parseVnd(it.unitCost) || 0;
    return s + Math.round(q * u);
  }, 0);
  const grand = lineMode ? lineSum : (parseVnd(amount) || 0);
  const canSubmit = grand > 0 && Boolean(categoryId) && !busy;

  function onPickPhoto() { fileRef.current?.click(); }

  async function onPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !merchantId) return;
    setOcrBusy(true); setError(null); setNotice(null); setWarnings([]);
    try {
      const { base64, mimeType } = await fileToBase64(file);
      const res = await api.aiExpensePreview(merchantId, base64, mimeType);
      const d = res.draft;
      if (d.payee) setPayee(d.payee);
      if (d.expenseDate) setExpenseDate(d.expenseDate);
      if (d.lines.length > 0) {
        setItems(d.lines.map((l) => ({ description: l.description, qty: String(l.quantity), unitCost: String(l.unitCostVnd) })));
      } else if (d.totalVnd != null) {
        setAmount(groupVnd(d.totalVnd));
      }
      const pre = matchCategoryCandidate(d.categoryCandidates, categories);
      if (pre) setCategoryId(pre);
      if (res.documentId) setDocumentId(res.documentId);
      setWarnings(d.warnings);
      setNotice("Đã đọc chứng từ. Vui lòng kiểm tra lại trước khi ghi nhận.");
    } catch (err) {
      // Fallback to manual entry with fields intact (EXP-05 / EXP-FR-12).
      setNotice("Chưa đọc được chứng từ, bạn có thể nhập tay. Ảnh vẫn được lưu.");
    } finally {
      setOcrBusy(false);
    }
  }

  function buildBody() {
    const base = {
      expenseDate, payeeName: payee.trim() || null, categoryId, documentId,
      paymentMethod: method, paymentConfirmed: confirmed,
    };
    if (lineMode) {
      const its: CreateExpenseItemInput[] = items.map((it) => ({
        description: it.description.trim() || "Khoản mục",
        quantity: Number(String(it.qty).replace(",", ".")) || 1,
        unitCostVnd: parseVnd(it.unitCost) || 0,
        source: "manual",
      }));
      return { ...base, items: its };
    }
    return { ...base, amountVnd: grand };
  }

  async function ensureDraft(): Promise<{ id: string; version: number }> {
    if (draftId) return { id: draftId, version: draftVersion };
    const d = await api.createExpense(merchantId, buildBody(), createKey);
    setDraftId(d.expense.id);
    setDraftVersion(d.expense.rowVersion);
    return { id: d.expense.id, version: d.expense.rowVersion };
  }

  async function doPost(id: string, version: number, ack: boolean) {
    return api.postExpense(merchantId, id, {
      expectedVersion: version,
      paymentFact: { method, confirmationStatus: confirmed ? "confirmed" : "unconfirmed" },
      duplicateReview: ack ? { status: "NOT_DUPLICATE" } : undefined,
    }, newIdempotencyKey());
  }

  async function submit() {
    if (!canSubmit) return;
    setBusy(true); setError(null);
    try {
      const { id, version } = await ensureDraft();
      const r = await doPost(id, version, false);
      done(r.expenseId);
    } catch (e) {
      if (e instanceof ApiError && e.code === "POSSIBLE_DUPLICATE_EXPENSE") {
        const cands = (e.details as { candidates?: DuplicateCandidate[] })?.candidates ?? [];
        setDupCandidates(cands);
      } else {
        setError(e instanceof ApiError ? e.message : "Không ghi nhận được. Vui lòng thử lại.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function proceedAnyway() {
    if (!draftId) return;
    setBusy(true); setError(null);
    try {
      const r = await doPost(draftId, draftVersion, true);
      done(r.expenseId);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không ghi nhận được.");
    } finally {
      setBusy(false);
      setDupCandidates(null);
    }
  }

  function done(expenseId: string) {
    nav(`/chi-phi/${expenseId}`, { replace: true });
  }

  function updateLine(i: number, patch: Partial<LineDraft>) {
    setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  }

  return (
    <div className="screen">
      <PageHeader title="Ghi khoản chi" onBack={() => nav(-1)} />
      <div className="content--plain form-scroll">
        {notice && <div className="card card--flat" style={{ background: "#eef6ff", marginBottom: 10 }}><div className="tiny">{notice}</div></div>}
        {warnings.length > 0 && (
          <div className="card card--flat" style={{ background: "#fdf6e3", marginBottom: 10 }}>
            {warnings.map((w, i) => <div key={i} className="tiny">⚠︎ {w}</div>)}
          </div>
        )}
        {error && <InlineError message={error} onClose={() => setError(null)} />}

        {/* Photo capture (optional) */}
        <button className="card card--flat" onClick={onPickPhoto} disabled={ocrBusy}
          style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left", marginBottom: 12 }}>
          <span className="grid__ic" style={{ background: "#6b4fd0" }}><IconCamera size={20} /></span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{ocrBusy ? "Đang đọc chứng từ…" : documentId ? "Đã đính kèm chứng từ" : "Chụp / tải hóa đơn"}</div>
            <div className="muted tiny">{documentId ? "Chạm để chụp lại" : "SoHo đọc thử số tiền, ngày, bên nhận — bạn luôn kiểm tra lại"}</div>
          </div>
          <IconSparkle size={18} />
        </button>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={onPhoto} />

        {/* Amount / lines */}
        {!lineMode ? (
          <div className="field">
            <label className="field__label">Tổng chi<span className="field__req"> *</span></label>
            <input className="input" inputMode="numeric" placeholder="0" value={amount}
              onChange={(e) => setAmount(groupVnd(parseVnd(e.target.value)))}
              style={{ fontSize: 24, fontWeight: 800, textAlign: "right" }} />
            <div className="muted tiny" style={{ marginTop: 4 }}>đồng (VND)</div>
          </div>
        ) : (
          <div className="field">
            <label className="field__label">Các dòng chi</label>
            <div className="stack">
              {items.map((it, i) => (
                <div key={i} className="card card--flat" style={{ padding: 10 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input className="input" placeholder="Mô tả" value={it.description} onChange={(e) => updateLine(i, { description: e.target.value })} style={{ flex: 1 }} />
                    <button className="step__back" aria-label="Xóa dòng" onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))}><IconTrash size={16} /></button>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <input className="input" inputMode="decimal" placeholder="SL" value={it.qty} onChange={(e) => updateLine(i, { qty: e.target.value })} style={{ width: 70 }} />
                    <span style={{ alignSelf: "center" }}>×</span>
                    <input className="input" inputMode="numeric" placeholder="Đơn giá" value={it.unitCost} onChange={(e) => updateLine(i, { unitCost: groupVnd(parseVnd(e.target.value)) })} style={{ flex: 1, textAlign: "right" }} />
                  </div>
                </div>
              ))}
            </div>
            <div className="kv" style={{ marginTop: 8 }}><span>Tổng</span><b>{formatVnd(grand)}</b></div>
          </div>
        )}
        <button className="btn btn--ghost" style={{ marginTop: 2, marginBottom: 10 }}
          onClick={() => setItems((xs) => [...xs, { description: "", qty: "1", unitCost: "" }])}>
          <IconPlus size={14} /> Tách dòng
        </button>

        {/* Date */}
        <div className="field">
          <label className="field__label">Ngày chi<span className="field__req"> *</span></label>
          <input className="input" type="date" value={expenseDate} max={today()} onChange={(e) => setExpenseDate(e.target.value)} />
        </div>

        {/* Payee */}
        <div className="field">
          <label className="field__label">Bên nhận <span className="field__opt">(không bắt buộc)</span></label>
          <input className="input" placeholder="VD: Điện lực, nhà cung cấp…" value={payee} onChange={(e) => setPayee(e.target.value)} maxLength={200} />
        </div>

        {/* Category */}
        <div className="field">
          <label className="field__label">Nhóm chi<span className="field__req"> *</span></label>
          <CategoryChips categories={categories} value={categoryId} onChange={setCategoryId} />
        </div>

        {/* Payment */}
        <div className="field">
          <label className="field__label">Thanh toán</label>
          <PaymentPicker method={method} confirmed={confirmed} onMethod={setMethod} onConfirmed={setConfirmed} />
        </div>
      </div>

      <div className="form-foot">
        <Button variant="primary" loading={busy} disabled={!canSubmit}
          disabledReason={!canSubmit ? (grand <= 0 ? "Nhập tổng chi lớn hơn 0" : "Chọn nhóm chi") : undefined} onClick={submit}>
          Ghi nhận chi phí
        </Button>
      </div>

      <DuplicateSheet open={Boolean(dupCandidates)} candidates={dupCandidates ?? []} busy={busy}
        onClose={() => setDupCandidates(null)} onProceed={proceedAnyway} />
    </div>
  );
}
