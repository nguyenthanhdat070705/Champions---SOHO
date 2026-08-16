// Functional 14 — the close flow (spec §3.2 prepare → §3.3 count → §3.5 variance
// → §3.6 preview → §3.7 confirm) on ONE immersive screen. The server owns every
// number: expected cash from frozen sources, the counted total from the count
// lines, and the variance. The confirm echoes a preview_hash so any source/count/
// reason drift invalidates the preview (409) instead of chốt-ing stale numbers.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageHeader, Banner, Button } from "../components/ui";
import { IconChevron, IconCheck } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import { formatVnd, formatBusinessDateVN } from "../lib/format";
import {
  DENOMINATIONS, REASON_CODES, optimisticDenominationTotal,
} from "../lib/closing";
import type { DraftDetail, ClosingPreview, CountMode } from "../lib/closing";
import { VarianceHero, DirAmount } from "./parts";

export function ClosingDraft() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const dateParam = sp.get("date") || undefined;
  const { merchant } = useMerchant();
  const merchantId = merchant?.id ?? "";

  const [detail, setDetail] = useState<DraftDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [mode, setMode] = useState<CountMode>("total");
  const [totalInput, setTotalInput] = useState("");
  const [qtys, setQtys] = useState<Record<number, string>>({});

  const [reasonCode, setReasonCode] = useState<string | null>(null);
  const [reasonNote, setReasonNote] = useState("");

  const [preview, setPreview] = useState<ClosingPreview | null>(null);
  const [consent, setConsent] = useState(false);
  const [savingCount, setSavingCount] = useState(false);
  const [busy, setBusy] = useState(false);
  const confirmKey = useRef<string>("");

  const draftId = detail?.draft.id ?? "";

  const prepare = useCallback(async () => {
    if (!merchantId) return;
    setError(null);
    try {
      const d = await api.closingPrepare(merchantId, dateParam);
      setDetail(d);
      // Resume any previously-saved count into the variance view.
      if (d.latestCount) setMode(d.latestCount.mode);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không chuẩn bị được bản chốt.");
    }
  }, [merchantId, dateParam]);

  useEffect(() => { void prepare(); }, [prepare]);

  function invalidatePreview() { setPreview(null); setConsent(false); }

  async function saveCount() {
    if (!merchantId || !draftId || savingCount) return;
    setSavingCount(true); setError(null); setNotice(null);
    try {
      const body = mode === "total"
        ? { clientCountId: newIdempotencyKey(), mode, countedTotalVnd: parseIntVnd(totalInput) }
        : {
            clientCountId: newIdempotencyKey(), mode,
            denominations: DENOMINATIONS
              .map((d) => ({ denominationVnd: d, quantity: Math.trunc(Number(qtys[d]) || 0) }))
              .filter((l) => l.quantity > 0),
          };
      const d = await api.closingSaveCount(merchantId, draftId, body);
      setDetail(d);
      invalidatePreview();
      if (d.variance !== null && d.variance === 0) { setReasonCode(null); setReasonNote(""); }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không lưu được tiền đếm.");
    } finally { setSavingCount(false); }
  }

  const counted = detail?.countedCashVnd ?? null;
  const variance = detail?.variance ?? null;
  const needsReason = variance !== null && variance !== 0;
  const reasonDef = REASON_CODES.find((r) => r.code === reasonCode);
  const reasonOk = !needsReason || (Boolean(reasonCode) && (!reasonDef?.needsNote || reasonNote.trim().length > 0));

  async function doPreview() {
    if (!merchantId || !draftId) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const p = await api.closingPreview(merchantId, draftId, {
        reasonCode: needsReason ? reasonCode : null,
        reasonNote: needsReason ? reasonNote : null,
      });
      setPreview(p);
      confirmKey.current = newIdempotencyKey();
      setConsent(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === "CLOSING_SOURCE_CHANGED") {
        setNotice("Có giao dịch tiền mặt mới cho ngày này. Đã cập nhật số kỳ vọng — vui lòng kiểm tra rồi chốt lại.");
        await prepare(); invalidatePreview();
      } else {
        setError(e instanceof ApiError ? e.message : "Không tạo được bản xem trước.");
      }
    } finally { setBusy(false); }
  }

  async function doConfirm() {
    if (!merchantId || !draftId || !preview) return;
    setBusy(true); setError(null);
    try {
      const res = await api.closingConfirm(merchantId, draftId, {
        previewHash: preview.previewHash, countVersion: preview.countVersion,
        reasonCode: needsReason ? reasonCode : null, reasonNote: needsReason ? reasonNote : null,
        responsibilityConfirmed: consent,
      }, confirmKey.current);
      nav(`/chot-tien/${res.closingId}`, { replace: true });
    } catch (e) {
      if (e instanceof ApiError && (e.code === "CLOSING_PREVIEW_STALE" || e.code === "CLOSING_SOURCE_CHANGED")) {
        setNotice("Số liệu vừa thay đổi. Vui lòng xem lại bản xem trước.");
        await prepare(); invalidatePreview();
      } else {
        setError(e instanceof ApiError ? e.message : "Chưa chốt được. Vui lòng thử lại.");
      }
      setBusy(false);
    }
  }

  if (!detail) {
    return (
      <div className="screen">
        <PageHeader title="Chốt ngày" onBack={() => nav("/chot-tien")} />
        <div className="content--plain">
          {error ? <Banner kind="error">{error}</Banner> : <div className="muted" style={{ textAlign: "center", padding: 24 }}>Đang chuẩn bị…</div>}
        </div>
      </div>
    );
  }

  const exp = detail.expected;
  const inPreview = Boolean(preview);

  return (
    <div className="screen">
      <PageHeader title={detail.draft.isReclose ? "Chốt lại ngày" : "Chốt tiền cuối ngày"} onBack={() => nav("/chot-tien")} />
      <div className="content--plain form-scroll">
        <div className="muted tiny" style={{ marginBottom: 8 }}>{formatBusinessDateVN(detail.draft.businessDate)}</div>
        {notice && <div className="card card--flat" style={{ background: "#eef6ff", marginBottom: 10 }}><div className="tiny">{notice}</div></div>}
        {error && <Banner kind="error">{error}</Banner>}

        {/* Expected cash + counted sources (spec §3.2) */}
        <div className="card card--flat cls-expected">
          <div className="cls-expected__lb">Tiền mặt kỳ vọng trong két</div>
          <div className="cls-expected__v">{formatVnd(exp.expectedCashVnd)}</div>
          <div className="muted tiny">
            {exp.cashBillCount} bill tiền mặt (+{formatVnd(exp.inflowVnd)})
            {exp.cashRefundCount > 0 ? ` · ${exp.cashRefundCount} hoàn tiền (−${formatVnd(exp.outflowVnd)})` : ""}
          </div>
          <div className="muted tiny" style={{ marginTop: 4 }}>QR/chuyển khoản không nằm trong két tiền mặt.</div>
        </div>

        {detail.sources.length > 0 && (
          <details className="cls-sources">
            <summary className="cls-sources__sum">Xem {detail.sources.length} nguồn đã tính <IconChevron size={14} /></summary>
            <div className="stack" style={{ marginTop: 8 }}>
              {detail.sources.map((s) => (
                <button key={`${s.sourceType}:${s.sourceId}`} className="card card--flat cls-src"
                  onClick={() => s.route && nav(s.route)} disabled={!s.route}>
                  <span className="cls-src__lb">{s.sourceType === "payment" ? "Bill tiền mặt" : "Hoàn tiền mặt"}</span>
                  <DirAmount direction={s.direction} amount={s.amountVnd} />
                </button>
              ))}
            </div>
          </details>
        )}

        {/* Count (spec §3.3) */}
        <div className="section-title" style={{ marginTop: 16 }}>Đếm tiền mặt thực tế</div>
        <div className="segment" style={{ marginTop: 8 }}>
          <button className={`segment__btn ${mode === "total" ? "segment__btn--on" : ""}`}
            onClick={() => { setMode("total"); invalidatePreview(); }}>Nhập tổng</button>
          <button className={`segment__btn ${mode === "denomination" ? "segment__btn--on" : ""}`}
            onClick={() => { setMode("denomination"); invalidatePreview(); }}>Theo mệnh giá</button>
        </div>

        {mode === "total" ? (
          <div className="field" style={{ marginTop: 12 }}>
            <label className="field__label">Tổng tiền mặt đã đếm</label>
            <input className="input" inputMode="numeric" placeholder="0" value={totalInput}
              onChange={(e) => { setTotalInput(groupVnd(e.target.value)); invalidatePreview(); }}
              style={{ fontSize: 24, fontWeight: 800, textAlign: "right" }} />
            <div className="muted tiny" style={{ marginTop: 4 }}>đồng (VND) — SoHo không điền sẵn theo số kỳ vọng</div>
          </div>
        ) : (
          <div className="cls-denoms" style={{ marginTop: 12 }}>
            {DENOMINATIONS.map((d) => {
              const q = Math.trunc(Number(qtys[d]) || 0);
              return (
                <div key={d} className="cls-denom">
                  <span className="cls-denom__note">{formatVnd(d)}</span>
                  <input className="input cls-denom__qty" inputMode="numeric" placeholder="0"
                    value={qtys[d] ?? ""} onChange={(e) => { setQtys((p) => ({ ...p, [d]: e.target.value.replace(/[^\d]/g, "") })); invalidatePreview(); }} />
                  <span className="cls-denom__sum">{q > 0 ? formatVnd(d * q) : "—"}</span>
                </div>
              );
            })}
            <div className="kv" style={{ marginTop: 6 }}>
              <span>Tạm tính (máy khách)</span>
              <b>{formatVnd(optimisticDenominationTotal(Object.fromEntries(DENOMINATIONS.map((d) => [d, Math.trunc(Number(qtys[d]) || 0)]))))}</b>
            </div>
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          <Button variant="outline" loading={savingCount} onClick={saveCount}>
            {counted === null ? "Lưu & so sánh" : "Đếm lại (lưu bản mới)"}
          </Button>
        </div>

        {/* Variance (spec §3.5) */}
        {counted !== null && (
          <>
            <div style={{ marginTop: 16 }}>
              <VarianceHero expected={exp.expectedCashVnd} counted={counted} variance={variance} />
            </div>
            {detail.latestCount && (
              <div className="muted tiny" style={{ marginTop: 4 }}>
                Bản đếm #{detail.latestCount.versionNo} · {detail.latestCount.mode === "total" ? "nhập tổng" : "theo mệnh giá"}
                {detail.counts.length > 1 ? ` · đã đếm ${detail.counts.length} lần (giữ tất cả)` : ""}
              </div>
            )}

            {needsReason && (
              <div className="field" style={{ marginTop: 14 }}>
                <label className="field__label">Lý do chênh lệch<span className="field__req"> *</span></label>
                <div className="cls-reasons">
                  {REASON_CODES.map((r) => (
                    <button key={r.code} className={`chip ${reasonCode === r.code ? "chip--on" : ""}`}
                      onClick={() => { setReasonCode(r.code); invalidatePreview(); }}>{r.label}</button>
                  ))}
                </div>
                {reasonDef?.needsNote && (
                  <input className="input" placeholder="Ghi chú lý do…" value={reasonNote} maxLength={200}
                    onChange={(e) => { setReasonNote(e.target.value); invalidatePreview(); }} style={{ marginTop: 8 }} />
                )}
              </div>
            )}
          </>
        )}

        {/* Preview + consent (spec §3.6) */}
        {inPreview && preview && (
          <div className="card cls-confirm" style={{ marginTop: 16 }}>
            <div className="cls-confirm__title">Xác nhận chốt ngày</div>
            <div className="kv"><span>Kỳ vọng</span><b>{formatVnd(preview.expectedCashVnd)}</b></div>
            <div className="kv"><span>Đã đếm</span><b>{formatVnd(preview.countedCashVnd)}</b></div>
            <div className="kv"><span>Chênh lệch</span><b className={preview.varianceVnd === 0 ? "" : preview.varianceVnd > 0 ? "cls-t--in" : "cls-t--out"}>{formatVnd(preview.varianceVnd)}</b></div>
            {preview.isReclose && <div className="muted tiny" style={{ marginTop: 6 }}>Đây là bản sửa đổi — bản chốt cũ vẫn được giữ nguyên.</div>}
            <label className="cls-consent">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>Tôi đã kiểm tra số liệu và chịu trách nhiệm về bản chốt này.</span>
            </label>
          </div>
        )}
      </div>

      <div className="form-foot">
        {!inPreview ? (
          <Button variant="primary" loading={busy} disabled={counted === null || !reasonOk}
            disabledReason={counted === null ? "Nhập và lưu tiền đếm trước" : !reasonOk ? "Chọn lý do chênh lệch" : undefined}
            onClick={doPreview}>
            Xem trước
          </Button>
        ) : (
          <Button variant="primary" loading={busy} disabled={!consent}
            disabledReason={!consent ? "Xác nhận trách nhiệm để chốt" : undefined} onClick={doConfirm}>
            <IconCheck size={18} /> Chốt ngày
          </Button>
        )}
      </div>
    </div>
  );
}

// ── input helpers ─────────────────────────────────────────────────────────────
function parseIntVnd(s: string): number {
  const n = Number(String(s).replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function groupVnd(s: string): string {
  const digits = String(s).replace(/[^\d]/g, "");
  if (!digits) return "";
  return Number(digits).toLocaleString("vi-VN");
}
