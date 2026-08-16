// Functional 14 — "Chốt ngày" list (spec §3.1). Shows which business days are
// closed, in progress, or need attention, and opens the right flow in one tap.
// Reads are any member; only owner/manager can start/continue a close (server
// enforces — the CTA is hidden for cashiers).
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader, Banner } from "../components/ui";
import { IconWallet, IconChevron, IconAlert } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api, ApiError } from "../lib/api";
import { formatVnd, formatBusinessDateVN } from "../lib/format";
import { signedVnd } from "../lib/closing";
import type { ClosingListItem } from "../lib/closing";
import { StatusBadge } from "./parts";

function subDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function ClosingPage() {
  const nav = useNavigate();
  const { merchant, role } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const canManage = role === "owner" || role === "manager";

  const [items, setItems] = useState<ClosingListItem[]>([]);
  const [today, setToday] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!merchantId) return;
    setLoading(true); setError(null);
    try {
      const res = await api.closingsList(merchantId);
      setToday(res.today);
      // Merge in synthetic "chưa chốt" rows for today + yesterday when missing.
      const byDate = new Map(res.closings.map((c) => [c.businessDate, c]));
      const merged: ClosingListItem[] = [...res.closings];
      for (const d of [res.today, subDays(res.today, 1)]) {
        if (!byDate.has(d)) {
          merged.push({
            id: "", businessDate: d, timezone: res.timezone, status: "draft",
            currentRevisionId: null, activeDraftId: null, revisionNo: null,
            expectedCashVnd: null, countedCashVnd: null, varianceVnd: null,
            confirmedAt: null, openAttention: 0,
          });
        }
      }
      merged.sort((a, b) => (a.businessDate < b.businessDate ? 1 : -1));
      setItems(merged);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tải được danh sách chốt ngày.");
    } finally { setLoading(false); }
  }, [merchantId]);

  useEffect(() => { void load(); }, [load]);

  function open(c: ClosingListItem) {
    // Confirmed / attention → the immutable detail + revision history.
    if (c.id && (c.status === "confirmed" || c.status === "attention")) {
      nav(`/chot-tien/${c.id}`);
      return;
    }
    // Not-yet-closed → the count/preview/confirm flow (owner/manager only).
    if (canManage) nav(`/chot-tien/moi?date=${c.businessDate}`);
  }

  const todayItem = items.find((c) => c.businessDate === today);

  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Chốt tiền cuối ngày" onBack={() => nav("/")} />
      <div className="content--plain">
        {error && <Banner kind="error">{error}</Banner>}

        {/* Trang chủ-style hero: "Két hôm nay khớp chưa?" */}
        {todayItem && (
          <button className="card cls-todaycard" onClick={() => open(todayItem)} disabled={!canManage && !todayItem.id}>
            <div className="cls-todaycard__top">
              <span className="cls-todaycard__ic"><IconWallet size={20} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="cls-todaycard__title">
                  {todayItem.status === "confirmed"
                    ? "Đã chốt hôm nay"
                    : todayItem.status === "attention"
                      ? "Két hôm nay cần xem lại"
                      : "Két hôm nay khớp chưa?"}
                </div>
                <div className="muted tiny">{formatBusinessDateVN(todayItem.businessDate)}</div>
              </div>
              <StatusBadge status={todayItem.id ? todayItem.status : "none"} />
            </div>
            {todayItem.varianceVnd !== null && (
              <div className="cls-todaycard__foot">
                Lệch <b>{signedVnd(todayItem.varianceVnd, formatVnd)}</b>
                {todayItem.openAttention > 0 && <span className="cls-chip-attn"><IconAlert size={12} /> {todayItem.openAttention} đến muộn</span>}
              </div>
            )}
          </button>
        )}

        <div className="section-title" style={{ marginTop: 16 }}>Các ngày</div>
        {loading ? (
          <div className="muted" style={{ textAlign: "center", padding: 24 }}>Đang tải…</div>
        ) : (
          <div className="stack" style={{ marginTop: 8 }}>
            {items.map((c) => (
              <button key={c.businessDate} className="card card--flat cls-row"
                onClick={() => open(c)} disabled={!canManage && !c.id}>
                <div className="cls-row__main">
                  <div className="cls-row__date">{formatBusinessDateVN(c.businessDate)}</div>
                  <div className="cls-row__sub">
                    {c.varianceVnd !== null
                      ? <>Kỳ vọng {formatVnd(c.expectedCashVnd ?? 0)} · lệch <b className={c.varianceVnd === 0 ? "" : c.varianceVnd > 0 ? "cls-t--in" : "cls-t--out"}>{signedVnd(c.varianceVnd, formatVnd)}</b>{c.revisionNo && c.revisionNo > 1 ? ` · bản ${c.revisionNo}` : ""}</>
                      : <span className="muted">Chưa chốt</span>}
                  </div>
                </div>
                {c.openAttention > 0 && <span className="cls-chip-attn"><IconAlert size={12} /> {c.openAttention}</span>}
                <StatusBadge status={c.id ? c.status : "none"} />
                <IconChevron size={18} color="#9aa7b4" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
