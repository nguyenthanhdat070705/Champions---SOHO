// Functional 11 — "Sổ thu–chi" (spec 3.1 overview + 3.2 entries list). The
// merchant sees money in/out with data coverage, a short "Cần xem" queue, and the
// posted entries for the period — every row deep-links back to its source. Totals
// are server-computed from posted entries only; the difference is NOT called
// profit (spec 3.1 rule). Owner/manager can sync sources and add a manual draft.
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader, Banner } from "../components/ui";
import { IconWallet, IconRefresh, IconPlus, IconAlert } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api, ApiError } from "../lib/api";
import type { CashbookSummary, CashbookEntryRow, CashbookPeriod } from "../lib/api";
import { formatVnd } from "../lib/format";
import { PERIOD_TABS } from "../lib/cashbook";
import { DirectionBadge, SourceChip, SignedAmount, MethodPill, fmtDate } from "./parts";
import { ManualDraftSheet } from "./ManualDraftSheet";

type DirFilter = "all" | "in" | "out";

export function CashbookPage() {
  const nav = useNavigate();
  const { merchant, role } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const canManage = role === "owner" || role === "manager";

  const [period, setPeriod] = useState<CashbookPeriod>("today");
  const [dir, setDir] = useState<DirFilter>("all");
  const [summary, setSummary] = useState<CashbookSummary | null>(null);
  const [entries, setEntries] = useState<CashbookEntryRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!merchantId) return;
    setLoading(true); setError(null);
    try {
      const s = await api.cashbookSummary(merchantId, { period });
      setSummary(s);
      const list = await api.cashbookEntries(merchantId, {
        from: s.from, to: s.to, direction: dir === "all" ? undefined : dir, limit: 30,
      });
      setEntries(list.entries); setCursor(list.nextCursor); setHasMore(list.hasMore);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tải được sổ thu–chi.");
    } finally { setLoading(false); }
  }, [merchantId, period, dir]);

  useEffect(() => { void load(); }, [load]);

  async function loadMore() {
    if (!merchantId || !summary || !cursor) return;
    const list = await api.cashbookEntries(merchantId, {
      from: summary.from, to: summary.to, direction: dir === "all" ? undefined : dir, cursor, limit: 30,
    });
    setEntries((prev) => [...prev, ...list.entries]);
    setCursor(list.nextCursor); setHasMore(list.hasMore);
  }

  async function sync() {
    if (!merchantId || syncing) return;
    setSyncing(true); setError(null);
    try { await api.cashbookSync(merchantId, {}); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Không đồng bộ được."); }
    finally { setSyncing(false); }
  }

  const cov = summary?.coverage;

  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Sổ thu–chi" onBack={() => nav("/")}
        right={canManage ? (
          <button className="step__back" aria-label="Đồng bộ nguồn" onClick={sync} disabled={syncing}>
            <IconRefresh size={18} />
          </button>
        ) : undefined} />

      <div className="content--plain cbk">
        <div className="seg-scroll">
          {PERIOD_TABS.map((t) => (
            <button key={t.value} className={`chip ${period === t.value ? "chip--on" : ""}`} onClick={() => setPeriod(t.value)}>{t.label}</button>
          ))}
        </div>

        {error && <Banner kind="error">{error}</Banner>}

        {/* Thu / Chi / Chênh lệch */}
        <div className="cbk-totals">
          <button className={`cbk-total ${dir === "in" ? "cbk-total--sel" : ""}`} onClick={() => setDir(dir === "in" ? "all" : "in")}>
            <span className="cbk-total__lb">Thu đã ghi</span>
            <span className="cbk-total__v cbk-total__v--in">{formatVnd(summary?.totalIn ?? 0)}</span>
          </button>
          <button className={`cbk-total ${dir === "out" ? "cbk-total--sel" : ""}`} onClick={() => setDir(dir === "out" ? "all" : "out")}>
            <span className="cbk-total__lb">Chi đã ghi</span>
            <span className="cbk-total__v cbk-total__v--out">{formatVnd(summary?.totalOut ?? 0)}</span>
          </button>
        </div>
        <div className="card card--flat cbk-diff">
          <span className="cbk-diff__lb">Chênh lệch tiền</span>
          <span className="cbk-diff__v">{formatVnd(summary?.difference ?? 0)}</span>
          <span className="muted tiny">Thu − Chi (không phải lợi nhuận)</span>
        </div>

        {/* Coverage (spec 3.1: always shown; no "Đầy đủ" label when issues) */}
        {cov && (
          <div className="cbk-coverage">
            <div className="cbk-coverage__bar"><div className="cbk-coverage__fill" style={{ width: `${cov.pct}%` }} /></div>
            <div className="muted tiny">
              Độ phủ dữ liệu: <b>{cov.pct}%</b> · đã ghi {cov.processed}/{cov.expected} khoản
              {cov.review > 0 ? ` · ${cov.review} chờ xem` : ""}
              {summary?.asOf ? ` · tính đến ${fmtDate(summary.asOf)}` : ""}
            </div>
          </div>
        )}

        {/* Cần xem queue */}
        {(summary?.reviewCount ?? 0) > 0 && (
          <button className="card card--flat cbk-review-card" onClick={() => nav("/so-quy/can-xem")}>
            <span className="cbk-review-card__ic"><IconAlert size={18} /></span>
            <span className="cbk-review-card__body">
              <b>Cần xem ({summary?.reviewCount})</b>
              <span className="muted tiny">Bổ sung thông tin để ghi vào sổ</span>
            </span>
            <span className="cbk-review-card__chev">›</span>
          </button>
        )}

        {/* Entries list */}
        <div className="section-title" style={{ marginTop: 14 }}>Dòng sổ</div>
        {loading ? (
          <div className="muted" style={{ textAlign: "center", padding: 24 }}>Đang tải…</div>
        ) : entries.length === 0 ? (
          <div className="empty" style={{ marginTop: 12 }}>
            <div className="empty__ic"><IconWallet size={26} /></div>
            <div className="empty__t">Chưa có dòng sổ trong kỳ</div>
            <div className="empty__d">Các khoản thu/chi từ bán hàng, hoàn tiền và nhập hàng sẽ tự vào đây.</div>
          </div>
        ) : (
          <div className="stack" style={{ marginTop: 8 }}>
            {entries.map((e) => (
              <button key={e.id} className="card card--flat cbk-row" onClick={() => nav(`/so-quy/${e.id}`)}>
                <div className="cbk-row__main">
                  <div className="cbk-row__top">
                    <DirectionBadge direction={e.direction} reversed={e.reversed} />
                    <span className="cbk-row__type">{e.entryLabel}</span>
                  </div>
                  <div className="cbk-row__sub">
                    <span className="muted tiny">{fmtDate(e.occurredAt)}</span> · <MethodPill method={e.paymentMethod} />
                    {" "}<SourceChip source={e.source} />
                  </div>
                </div>
                <SignedAmount direction={e.direction} amount={e.amountVnd} />
              </button>
            ))}
            {hasMore && (
              <button className="btn btn--outline" onClick={loadMore} style={{ marginTop: 4 }}>Tải thêm</button>
            )}
          </div>
        )}
      </div>

      {canManage && (
        <button className="fab" onClick={() => setManualOpen(true)} aria-label="Ghi tay">
          <IconPlus size={22} /> <span>Ghi tay</span>
        </button>
      )}

      <ManualDraftSheet open={manualOpen} onClose={() => setManualOpen(false)} merchantId={merchantId}
        onCreated={(reviewId) => { setManualOpen(false); nav(`/so-quy/can-xem/${reviewId}`); }} />
    </div>
  );
}
