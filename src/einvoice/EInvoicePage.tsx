// Functional 09 screen 3.1 — "Hóa đơn điện tử" centre: search, status filter chips,
// invoice cards and the "Tạo hóa đơn" FAB. Read for any member; create is gated to
// owner/manager (the server enforces the same). Route: /hoa-don.
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMerchant } from "../dashboard/MerchantContext";
import { PageHeader, EmptyState, LoadingScreen } from "../components/ui";
import { IconReceipt, IconSearch, IconPlus } from "../components/icons";
import { api, ApiError } from "../lib/api";
import type { EInvoiceListItem } from "../lib/api";
import { STATUS_FILTERS, formatVnd } from "../lib/einvoice";
import { StatusBadge, MockProviderBanner } from "./parts";

const PRIVILEGED = ["owner", "manager"];

export function EInvoicePage() {
  const nav = useNavigate();
  const { merchant, role, loading: mLoading } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const canCreate = role != null && PRIVILEGED.includes(role);

  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<EInvoiceListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!merchantId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.einvoiceList(merchantId, { status: status || undefined, search: search.trim() || undefined });
      setItems(res.invoices);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tải được danh sách hóa đơn.");
    } finally {
      setLoading(false);
    }
  }, [merchantId, status, search]);

  useEffect(() => { void load(); }, [load]);

  if (mLoading && !merchant) return <LoadingScreen />;

  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Hóa đơn điện tử" onBack={() => nav("/")} />
      <div className="content--plain stack">
        <MockProviderBanner />

        <div className="pos-search" style={{ padding: 0 }}>
          <div className="pos-search__box">
            <IconSearch size={19} />
            <input
              className="pos-search__input"
              placeholder="Số HĐ / bill / người mua / mã tra cứu"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && load()}
              inputMode="search"
            />
          </div>
        </div>

        <div className="seg-scroll">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value || "all"}
              className={`chip ${status === f.value ? "chip--on" : ""}`}
              onClick={() => setStatus(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>

        {error && <div className="banner banner--error">{error}</div>}

        {loading ? (
          <div className="center-screen"><div className="spinner" /></div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<IconReceipt size={30} />}
            title="Chưa có hóa đơn"
            desc={canCreate ? "Tạo hóa đơn từ một bill đã thanh toán." : "Chưa có hóa đơn nào trong cửa hàng."}
          />
        ) : (
          <div className="stack">
            {items.map((it) => (
              <button key={it.id} className="card card--flat" style={{ display: "block", width: "100%", textAlign: "left" }} onClick={() => nav(`/hoa-don/${it.id}`)}>
                <div className="row-between" style={{ alignItems: "flex-start" }}>
                  <div>
                    <div className="list-row__t">
                      {it.providerInvoiceRef || (it.orderNumber ? `Bill ${it.orderNumber}` : "Hóa đơn")}
                    </div>
                    <div className="list-row__d">
                      {it.buyerName || "Khách lẻ"}
                      {it.orderNumber ? ` · ${it.orderNumber}` : ""}
                    </div>
                  </div>
                  <StatusBadge status={it.status} />
                </div>
                <div className="row-between" style={{ marginTop: 8 }}>
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    {new Date(it.createdAt).toLocaleDateString("vi-VN")}
                  </span>
                  <b>{formatVnd(it.totalVnd)}</b>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {canCreate && (
        <button className="fab" onClick={() => nav("/hoa-don/tao")} aria-label="Tạo hóa đơn">
          <IconPlus size={22} />
        </button>
      )}
    </div>
  );
}
