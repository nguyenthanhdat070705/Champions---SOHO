// "Đơn hàng" — the real bill list (spec 3.11). Filter by day/status; tap a row
// to open the bill detail. Reads go through the server API (RLS-scoped). Old
// bills without line items are tolerated in the detail view.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/ui";
import { IconReceipt } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api } from "../lib/api";
import type { OrderView } from "../lib/api";
import { formatVnd, formatClockVN } from "../lib/format";

type Row = OrderView["order"] & { itemCount: number; paidMethod: string | null };

function todayHcm(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
}

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  paid: { label: "Đã thanh toán", cls: "chip--good" },
  refunded: { label: "Đã hoàn toàn bộ", cls: "chip--amber" },
  partially_refunded: { label: "Hoàn một phần", cls: "chip--amber" },
  cancelled: { label: "Đã hủy", cls: "" },
  awaiting_payment: { label: "Chờ thanh toán", cls: "chip--teal" },
  draft: { label: "Nháp", cls: "" },
};

export function OrdersPage() {
  const nav = useNavigate();
  const { merchant } = useMerchant();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<"today" | "all">("today");

  useEffect(() => {
    if (!merchant) return;
    let active = true;
    setLoading(true);
    api.listOrders(merchant.id)
      .then((r) => { if (active) setRows(r.orders); })
      .catch(() => { if (active) setRows([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [merchant]);

  const filtered = useMemo(() => {
    if (period === "all") return rows;
    const t = todayHcm();
    return rows.filter((r) => String(r.businessDate).slice(0, 10) === t);
  }, [rows, period]);

  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Đơn hàng" onBack={() => nav("/")} />
      <div className="content--plain">
        <div className="segment">
          <button className={`segment__btn ${period === "today" ? "segment__btn--on" : ""}`} onClick={() => setPeriod("today")}>Hôm nay</button>
          <button className={`segment__btn ${period === "all" ? "segment__btn--on" : ""}`} onClick={() => setPeriod("all")}>Tất cả</button>
        </div>

        {loading ? (
          <div className="muted" style={{ textAlign: "center", padding: 30 }}>Đang tải…</div>
        ) : filtered.length === 0 ? (
          <div className="empty">
            <div className="empty__ic"><IconReceipt size={28} /></div>
            <div className="empty__t">Chưa có bill</div>
            <div className="empty__d">Các bill đã tạo sẽ hiển thị ở đây. Bấm “Tạo bill” ở Trang chủ để bắt đầu.</div>
          </div>
        ) : (
          <div className="bill-list">
            {filtered.map((o) => {
              const st = STATUS_LABEL[o.status] ?? { label: o.status, cls: "" };
              return (
                <button key={o.id} className="bill-row" onClick={() => nav(`/don-hang/${o.id}`)}>
                  <div className="bill-row__main">
                    <div className="bill-row__num">{o.orderNumber}</div>
                    <div className="bill-row__sub">
                      {formatClockVN(o.paidAt ?? o.createdAt)} · {o.itemCount > 0 ? `${o.itemCount} mặt hàng` : "bill cũ"}
                      {o.paidMethod && ` · ${o.paidMethod === "cash" ? "Tiền mặt" : "QR"}`}
                    </div>
                  </div>
                  <div className="bill-row__right">
                    <div className="bill-row__amt">{formatVnd(o.totalAmount)}</div>
                    <span className={`chip ${st.cls}`}>{st.label}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
