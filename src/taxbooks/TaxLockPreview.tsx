// Functional 15 — lock preview + commit (spec §3.7, §7.1). Shows the frozen book
// totals, coverage, blocking issues and version, then locks the immutable snapshot
// after a responsibility confirmation. Immersive (fixed .form-foot CTA).
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMerchant } from "../dashboard/MerchantContext";
import { PageHeader, Banner, LoadingScreen, CheckRow } from "../components/ui";
import { IconLock } from "../components/icons";
import { formatVnd } from "../lib/format";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import type { TaxLockPreview as Preview } from "../lib/api";

const BOOK_LABEL: Record<string, string> = {
  sales_revenue: "Sổ doanh thu", cash_book: "Sổ quỹ tiền mặt", bank_book: "Sổ ngân hàng",
  expenses: "Sổ chi phí", materials_goods: "Sổ vật liệu – hàng hóa",
};

export function TaxLockPreview() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const period = sp.get("period") || "";
  const { merchant } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const [pv, setPv] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [locking, setLocking] = useState(false);

  useEffect(() => {
    if (!merchantId || !period) return;
    setLoading(true); setErr(null);
    api.taxPeriodPreview(merchantId, period)
      .then(setPv)
      .catch((e) => setErr(e instanceof ApiError ? e.message : "Không tạo được bản xem trước."))
      .finally(() => setLoading(false));
  }, [merchantId, period]);

  async function onLock() {
    if (!pv || !merchantId) return;
    setLocking(true); setErr(null);
    try {
      const res = await api.taxPeriodLock(merchantId, {
        period, previewHash: pv.previewHash, asOf: pv.asOf, responsibilityConfirmed: true,
      }, newIdempotencyKey());
      nav(`/so-sach/goi/${res.snapshotId}`, { replace: true });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Khóa kỳ thất bại.");
      // On a stale preview, reload it so the user re-reviews.
      if (e instanceof ApiError && e.status === 409) {
        try { setPv(await api.taxPeriodPreview(merchantId, period)); } catch { /* keep error */ }
      }
    } finally { setLocking(false); }
  }

  if (loading && !pv) return <LoadingScreen />;

  return (
    <div className="screen">
      <PageHeader title="Xem trước & khóa kỳ" onBack={() => nav(-1)} />
      <div className="content--plain stack" style={{ paddingBottom: 120 }}>
        {err && <Banner kind="error">{err}</Banner>}
        {pv && (
          <>
            <div className="card">
              <div className="row-between">
                <div className="stat-card__label">{pv.period.label}</div>
                <span className="chip chip--teal">Bản v{pv.versionNo}{pv.isRestatement ? " (khóa lại)" : ""}</span>
              </div>
              <div className="stat-card__value" style={{ fontSize: 24 }}>{formatVnd(pv.revenueVnd)}</div>
              <div className="list-row__d">Doanh thu thuần · {pv.recordCount} dòng sổ · as_of {new Date(pv.asOf).toLocaleString("vi-VN")}</div>
            </div>

            <div className="card">
              <div className="section-title" style={{ marginBottom: 8 }}>Tổng theo sổ</div>
              {pv.bookTotals.map((b) => (
                <div key={b.code} className="row-between" style={{ padding: "6px 0" }}>
                  <span className="list-row__d">{BOOK_LABEL[b.code] || b.code}</span>
                  <b style={{ color: b.total < 0 ? "var(--red, #c0392b)" : undefined }}>{formatVnd(b.total)}</b>
                </div>
              ))}
            </div>

            <div className="card">
              <div className="row-between">
                <span className="list-row__d">Độ đầy đủ nguồn</span>
                <b>{pv.coverage.pct}% · {pv.coverage.processed}/{pv.coverage.expected}</b>
              </div>
            </div>

            {pv.blocking.length > 0 && (
              <Banner kind="error">
                {pv.blocking.map((b) => <div key={b.code}>• {b.message}</div>)}
              </Banner>
            )}
            {pv.warnings.map((w) => <Banner key={w.code} kind="warn">{w.message}</Banner>)}

            <div className="card">
              <CheckRow checked={confirmed} onToggle={() => setConfirmed((v) => !v)}>
                Tôi xác nhận đã kiểm tra số liệu và chịu trách nhiệm về bản chốt kỳ này.
              </CheckRow>
              <p className="field__hint" style={{ marginTop: 8 }}>
                Khóa kỳ tạo một bản snapshot bất biến (hash {pv.previewHash.slice(0, 18)}…). Không gửi dữ liệu ra cơ quan thuế.
              </p>
            </div>
          </>
        )}
      </div>
      <div className="form-foot">
        <button className="btn btn--primary" style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
          disabled={!pv || !pv.canLock || !confirmed || locking} onClick={onLock}>
          <IconLock size={18} /> {locking ? "Đang khóa…" : "Khóa kỳ"}
        </button>
      </div>
    </div>
  );
}
