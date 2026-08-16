// Functional 09 screen 3.2 — "Chọn bill để xuất hóa đơn". Lists paid bills with no
// active original invoice; tapping one creates a DRAFT (server snapshots lines + tax
// mapping) and opens the detail. Eligibility is decided by the server from F03, never
// a client flag. Route: /hoa-don/tao (immersive).
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMerchant } from "../dashboard/MerchantContext";
import { PageHeader, EmptyState, LoadingScreen, Banner } from "../components/ui";
import { IconReceipt, IconSearch, IconChevron } from "../components/icons";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import type { EInvoiceEligibleOrder } from "../lib/api";
import { formatVnd } from "../lib/einvoice";
import { MockProviderBanner } from "./parts";

export function CreateInvoice() {
  const nav = useNavigate();
  const { merchant, loading: mLoading } = useMerchant();
  const merchantId = merchant?.id ?? "";

  const [search, setSearch] = useState("");
  const [orders, setOrders] = useState<EInvoiceEligibleOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creatingId, setCreatingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!merchantId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.einvoiceEligibleOrders(merchantId, { search: search.trim() || undefined });
      setOrders(res.orders);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tải được danh sách bill.");
    } finally {
      setLoading(false);
    }
  }, [merchantId, search]);

  useEffect(() => { void load(); }, [load]);

  async function createFrom(order: EInvoiceEligibleOrder) {
    if (creatingId) return;
    setCreatingId(order.id);
    setError(null);
    try {
      const res = await api.einvoiceCreate(merchantId, { orderId: order.id, buyerKind: "individual" }, newIdempotencyKey());
      nav(`/hoa-don/${res.invoice.id}`, { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tạo được hóa đơn.");
      setCreatingId(null);
    }
  }

  if (mLoading && !merchant) return <LoadingScreen />;

  return (
    <div className="screen">
      <PageHeader title="Chọn bill để xuất hóa đơn" onBack={() => nav("/hoa-don")} />
      <div className="content--plain stack">
        <MockProviderBanner />

        <div className="pos-search" style={{ padding: 0 }}>
          <div className="pos-search__box">
            <IconSearch size={19} />
            <input
              className="pos-search__input"
              placeholder="Tìm theo số bill…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && load()}
              inputMode="search"
            />
          </div>
        </div>

        {error && <div className="banner banner--error">{error}</div>}

        {loading ? (
          <div className="muted" style={{ textAlign: "center", padding: 30 }}>Đang tải…</div>
        ) : orders.length === 0 ? (
          <EmptyState
            icon={<IconReceipt size={30} />}
            title="Không có bill đủ điều kiện"
            desc="Chỉ bill đã thanh toán và chưa xuất hóa đơn mới hiện ở đây."
          />
        ) : (
          <>
            <Banner kind="info">
              Chỉ hiển thị bill đã thanh toán và chưa có hóa đơn gốc. Bill đã hoàn trả
              hoặc chưa thu tiền sẽ không xuất được.
            </Banner>
            <div className="stack">
              {orders.map((o) => (
                <button
                  key={o.id}
                  className="card card--flat"
                  style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left", opacity: creatingId && creatingId !== o.id ? 0.5 : 1 }}
                  onClick={() => createFrom(o)}
                  disabled={Boolean(creatingId)}
                >
                  <div className="list-row__ic"><IconReceipt size={20} /></div>
                  <div style={{ flex: 1 }}>
                    <div className="list-row__t">{o.orderNumber}</div>
                    <div className="list-row__d">
                      {o.itemCount} mặt hàng · {o.paidAt ? new Date(o.paidAt).toLocaleDateString("vi-VN") : ""}
                    </div>
                  </div>
                  <b style={{ marginRight: 4 }}>{formatVnd(o.totalAmount)}</b>
                  {creatingId === o.id ? <span className="spinner spinner--sm" /> : <IconChevron size={18} />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
