// Functional 11 — "Cần xem" (spec 3.3). A short queue of events the mapper could
// not fully resolve: each card shows the amount, source and what is missing, with
// a finite set of actions (bổ sung → preview → ghi, or loại). No "duyệt tất cả".
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/ui";
import { IconCheck } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api, ApiError } from "../lib/api";
import type { CashbookReviewItem } from "../lib/api";
import { formatVnd } from "../lib/format";
import { entryTypeLabel } from "../lib/cashbook";
import { fmtDate } from "./parts";

const REASON_TABS: { value: string | null; label: string }[] = [
  { value: null, label: "Tất cả" },
  { value: "missing_type", label: "Thiếu loại" },
  { value: "missing_payment_method", label: "Thiếu phương thức" },
  { value: "needs_payment_confirmation", label: "Cần xác nhận" },
];

export function ReviewQueue() {
  const nav = useNavigate();
  const { merchant } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const [tab, setTab] = useState<string | null>(null);
  const [items, setItems] = useState<CashbookReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!merchantId) return;
    setLoading(true); setError(null);
    try {
      const r = await api.cashbookReview(merchantId, { reasonCode: tab ?? undefined });
      setItems(r.items);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tải được hàng đợi.");
    } finally { setLoading(false); }
  }, [merchantId, tab]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Cần xem" onBack={() => nav("/so-quy")} />
      <div className="content--plain cbk">
        <div className="seg-scroll">
          {REASON_TABS.map((t) => (
            <button key={t.label} className={`chip ${tab === t.value ? "chip--on" : ""}`} onClick={() => setTab(t.value)}>{t.label}</button>
          ))}
        </div>

        {error && <div className="banner banner--error">{error}</div>}

        {loading ? (
          <div className="muted" style={{ textAlign: "center", padding: 24 }}>Đang tải…</div>
        ) : items.length === 0 ? (
          <div className="empty" style={{ marginTop: 16 }}>
            <div className="empty__ic"><IconCheck size={26} /></div>
            <div className="empty__t">Không có khoản nào cần xem</div>
            <div className="empty__d">Mọi khoản đủ dữ liệu đã được ghi tự động vào sổ.</div>
          </div>
        ) : (
          <div className="stack" style={{ marginTop: 8 }}>
            {items.map((it) => (
              <button key={it.id} className="card card--flat cbk-review-row" onClick={() => nav(`/so-quy/can-xem/${it.id}`)}>
                <div className="cbk-review-row__head">
                  <span className="cbk-review-row__amt">{it.draft.amountVnd != null ? formatVnd(it.draft.amountVnd) : "—"}</span>
                  <span className={`pill ${it.ready ? "pill--in" : "pill--low"}`}>{it.ready ? "Sẵn sàng" : "Thiếu thông tin"}</span>
                </div>
                <div className="muted tiny">
                  {it.draft.sourceLabel || "Ghi tay"} · {entryTypeLabel(it.draft.entryType)}
                  {it.draft.occurredAt ? ` · ${fmtDate(it.draft.occurredAt)}` : ""}
                </div>
                <div className="cbk-review-row__reasons">
                  {it.reasons.map((r) => <span key={r.code} className="chip chip--reason">{r.label}</span>)}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
