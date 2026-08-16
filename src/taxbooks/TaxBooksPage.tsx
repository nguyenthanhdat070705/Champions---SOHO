// Functional 15 — "Sổ kế toán & dữ liệu thuế" overview (spec §3.1). Shows the
// period's coverage, revenue, the S-HKD book set, the snapshot/lock state and the
// tax-data package entry. Reads are any member; sync/lock are owner/manager.
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMerchant } from "../dashboard/MerchantContext";
import { PageHeader, Banner, LoadingScreen } from "../components/ui";
import { IconChevron, IconRefresh, IconLock, IconFile, IconShield } from "../components/icons";
import { formatVnd } from "../lib/format";
import { api, ApiError } from "../lib/api";
import type { TaxOverview, TaxSnapshotList } from "../lib/api";
import { periodChoices } from "./parts";

export function TaxBooksPage() {
  const nav = useNavigate();
  const { merchant, role } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const canWrite = role === "owner" || role === "manager";
  const choices = periodChoices();
  const [period, setPeriod] = useState(choices[0].key);
  const [data, setData] = useState<TaxOverview | null>(null);
  const [snaps, setSnaps] = useState<TaxSnapshotList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    if (!merchantId) return;
    setLoading(true); setErr(null);
    try {
      const [o, s] = await Promise.all([
        api.taxAccountingOverview(merchantId, period),
        api.taxSnapshots(merchantId, period),
      ]);
      setData(o); setSnaps(s);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Không tải được dữ liệu.");
    } finally { setLoading(false); }
  }, [merchantId, period]);

  useEffect(() => { void load(); }, [load]);

  async function onSync() {
    if (!merchantId) return;
    setSyncing(true); setErr(null);
    try {
      const [y, m] = period.split("-");
      const from = period.includes("Q") ? `${y}-01-01` : `${y}-${m}-01`;
      await api.taxSync(merchantId, { from, to: undefined });
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Đồng bộ thất bại.");
    } finally { setSyncing(false); }
  }

  if (loading && !data) return <LoadingScreen />;

  const cov = data?.coverage;
  const covPct = cov?.pct ?? 0;
  const statusLabel: Record<string, string> = { open: "Đang mở", review: "Đang kiểm", locked: "Đã khóa", attention: "Có nguồn đến muộn" };

  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Sổ kế toán & dữ liệu thuế" onBack={() => nav("/thue")}
        right={canWrite ? (
          <button className="step__back" onClick={onSync} disabled={syncing} aria-label="Đồng bộ">
            <IconRefresh size={18} />
          </button>
        ) : undefined} />
      <div className="content--plain stack">
        {err && <Banner kind="error">{err}</Banner>}

        <div className="seg-scroll" role="tablist">
          {choices.map((c) => (
            <button key={c.key} className={`chip ${c.key === period ? "chip--on" : ""}`} onClick={() => setPeriod(c.key)}>
              {c.label}
            </button>
          ))}
        </div>

        {data && (
          <>
            <div className="card">
              <div className="row-between">
                <div className="stat-card__label">Doanh thu trong kỳ (thuần)</div>
                <span className={`chip ${data.period.status === "locked" ? "chip--teal" : "chip--amber"}`}>
                  {statusLabel[data.period.status] ?? data.period.status}
                </span>
              </div>
              <div className="stat-card__value" style={{ fontSize: 26 }}>{formatVnd(data.revenueVnd)}</div>
              <div className="bar" style={{ marginTop: 12 }}>
                <div className="bar__fill" style={{ width: `${covPct}%` }} />
              </div>
              <div className="row-between" style={{ marginTop: 8, fontSize: 12.5, color: "var(--muted)" }}>
                <span>Độ đầy đủ nguồn</span>
                <span><b>{covPct}%</b> · {cov?.processed}/{cov?.expected} nguồn</span>
              </div>
              {!cov?.complete && (
                <p className="field__hint" style={{ marginTop: 8 }}>
                  Còn {cov?.missing} nguồn chưa vào sổ.{canWrite ? " Bấm nút đồng bộ ở góc trên để cập nhật." : ""}
                </p>
              )}
              {data.lateCount > 0 && (
                <p className="field__hint" style={{ marginTop: 8, color: "var(--amber-700, #b8862f)" }}>
                  Có {data.lateCount} nguồn đến sau khi khóa kỳ — cần khóa lại (bản mới).
                </p>
              )}
            </div>

            <div className="section-title">Sổ áp dụng (TT 152/2025 — hộ bán lẻ)</div>
            <div className="stack" style={{ gap: 8 }}>
              {data.books.map((b) => (
                <button key={b.code} className="card list-row" style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left" }}
                  onClick={() => nav(`/so-sach/so/${b.code}?period=${period}`)}>
                  <div className="list-row__ic"><IconFile size={18} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="list-row__t">{b.short}</div>
                    <div className="list-row__d">{b.count} dòng · {b.legalRef}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className="list-row__t" style={{ color: b.total < 0 ? "var(--red, #c0392b)" : undefined }}>{formatVnd(b.total)}</div>
                  </div>
                  <IconChevron size={16} />
                </button>
              ))}
            </div>

            {canWrite && data.period.status !== "locked" && (
              <button className="btn btn--primary" onClick={() => nav(`/so-sach/khoa?period=${period}`)} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <IconLock size={18} /> Xem trước & khóa kỳ
              </button>
            )}
            {canWrite && data.period.status === "attention" && (
              <button className="btn btn--outline" onClick={() => nav(`/so-sach/khoa?period=${period}`)} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <IconLock size={18} /> Khóa lại (bản mới)
              </button>
            )}

            {snaps && snaps.snapshots.length > 0 && (
              <>
                <div className="section-title">Bản chốt kỳ</div>
                <div className="stack" style={{ gap: 8 }}>
                  {snaps.snapshots.map((s) => (
                    <button key={s.id} className="card list-row" style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left" }}
                      onClick={() => nav(`/so-sach/goi/${s.id}`)}>
                      <div className="list-row__ic"><IconShield size={18} /></div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="list-row__t">Bản v{s.versionNo}{s.isCurrent ? " (hiện hành)" : ""}</div>
                        <div className="list-row__d">Khóa {new Date(s.lockedAt).toLocaleString("vi-VN")} · {s.coverage?.pct ?? 100}% nguồn</div>
                      </div>
                      <IconChevron size={16} />
                    </button>
                  ))}
                </div>
              </>
            )}

            <Banner kind="info">
              Đây là dữ liệu chuẩn bị theo TT 152/2025 — <b>không phải tờ khai đã nộp</b> và không phải số thuế
              phải nộp cuối cùng. Cần kế toán/CQT xác nhận trước khi kê khai.
            </Banner>
          </>
        )}
      </div>
    </div>
  );
}
