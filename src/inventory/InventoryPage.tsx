// "Tồn kho" — the inventory overview inside Kho (spec 3.1). Shows on-hand /
// available / low-stock badge per tracked product, a search box, and the
// Tất cả/Thấp/Hết/Âm filters (informational only — no push notifications, spec
// 3.1). Owner/manager get a "Kiểm kho" entry and a quick-adjust FAB; a cashier is
// view-only (the server enforces the same). Tapping a row opens its stock ledger.
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/ui";
import { Sheet } from "../sales/ui";
import { IconBox, IconSearch, IconPlus, IconRefresh, IconClock } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api } from "../lib/api";
import type { InventoryLevel, InventoryFilter, InventoryOverview } from "../lib/api";
import { useDebounced } from "../catalog/parts";
import { unitLabel } from "../lib/catalog";
import { fmtQty } from "../lib/inventory";
import { StateBadge, AdjustSheet } from "./parts";
import type { AdjustTarget } from "./parts";

const FILTERS: { key: InventoryFilter; label: string; countKey: keyof InventoryOverview["summary"] | null }[] = [
  { key: "all", label: "Tất cả", countKey: "total" },
  { key: "low", label: "Sắp hết", countKey: "low" },
  { key: "zero", label: "Hết hàng", countKey: "zero" },
  { key: "negative", label: "Âm kho", countKey: "negative" },
];

export function InventoryPage() {
  const nav = useNavigate();
  const { merchant, role } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const canManage = role === "owner" || role === "manager";

  const [searchParams] = useSearchParams();
  const initialFilter = (["low", "zero", "negative"].includes(searchParams.get("filter") || "") ? searchParams.get("filter") : "all") as InventoryFilter;
  const [data, setData] = useState<InventoryOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InventoryFilter>(initialFilter);
  const [pickOpen, setPickOpen] = useState(false);
  const [adjustTarget, setAdjustTarget] = useState<AdjustTarget | null>(null);
  const debouncedSearch = useDebounced(search, 280);

  function load() {
    if (!merchantId) return;
    setLoading(true);
    api.inventoryList(merchantId, { search: debouncedSearch.trim() || undefined, filter, limit: 300 })
      .then(setData)
      .catch(() => setData({ products: [], hasMore: false, nextOffset: null, summary: { total: 0, negative: 0, zero: 0, low: 0 } }))
      .finally(() => setLoading(false));
  }
  useEffect(load, [merchantId, debouncedSearch, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  const products = data?.products ?? [];
  const summary = data?.summary ?? { total: 0, negative: 0, zero: 0, low: 0 };

  function openAdjust(p: InventoryLevel) {
    setPickOpen(false);
    setAdjustTarget({ productId: p.productId, name: p.name, unitCode: p.unitCode, onHand: p.onHand });
  }

  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Tồn kho" onBack={() => nav("/kho")}
        right={
          <button className="step__back" aria-label="Kiểm kho" onClick={() => nav("/ton-kho/kiem-kho")}>
            <IconClock size={19} />
          </button>
        } />
      <div className="content--plain catalog">
        <div className="pos-search" style={{ padding: 0, marginBottom: 10 }}>
          <div className="pos-search__box">
            <IconSearch size={19} />
            <input className="pos-search__input" placeholder="Tìm tên hoặc SKU…" value={search}
              onChange={(e) => setSearch(e.target.value)} inputMode="search" />
          </div>
        </div>

        <div className="seg-scroll">
          {FILTERS.map((f) => {
            const n = f.countKey ? summary[f.countKey] : null;
            return (
              <button key={f.key} className={`chip ${filter === f.key ? "chip--on" : ""}`} onClick={() => setFilter(f.key)}>
                {f.label}{n != null ? ` (${n})` : ""}
              </button>
            );
          })}
        </div>

        {canManage && (
          <div className="inv-actions">
            <button className="btn btn--navy" onClick={() => nav("/ton-kho/kiem-kho/moi")}>Bắt đầu kiểm kho</button>
            {role === "owner" && <button className="btn btn--outline" onClick={() => nav("/ton-kho/doi-chieu")}><IconRefresh size={15} /> Đối chiếu</button>}
          </div>
        )}

        {loading ? (
          <div className="muted" style={{ textAlign: "center", padding: 30 }}>Đang tải…</div>
        ) : products.length === 0 ? (
          <div className="empty" style={{ marginTop: 20 }}>
            <div className="empty__ic"><IconBox size={28} /></div>
            <div className="empty__t">{search ? "Không tìm thấy" : filter === "all" ? "Chưa có hàng theo dõi tồn" : "Không có sản phẩm ở nhóm này"}</div>
            <div className="empty__d">{search ? "Thử từ khóa khác." : "Bật “Theo dõi tồn” cho hàng hóa trong Kho để quản lý số lượng."}</div>
          </div>
        ) : (
          <div className="stack" style={{ marginTop: 12 }}>
            {products.map((p) => (
              <button key={p.productId} className="card card--flat inv-row" onClick={() => nav(`/ton-kho/${p.productId}`)}>
                <div className="catalog-row__main">
                  <div className="inv-row__name">{p.name} <StateBadge state={p.state} /></div>
                  <div className="muted tiny">
                    {unitLabel(p.unitCode)}{p.sku ? ` · ${p.sku}` : ""}
                    {p.reserved > 0 ? ` · đang giữ ${fmtQty(p.reserved)}` : ""}
                  </div>
                </div>
                <div className="inv-row__stock">
                  <span className={`inv-row__qty ${p.state === "low" ? "inv-row__qty--low" : ""} ${p.state === "zero" || p.state === "negative" ? "inv-row__qty--out" : ""}`}>{fmtQty(p.onHand)}</span>
                  <span className="muted tiny">{p.reserved > 0 ? `khả dụng ${fmtQty(p.available)}` : "tồn"}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {canManage && (
        <button className="fab" onClick={() => setPickOpen(true)} aria-label="Điều chỉnh tồn">
          <IconPlus size={22} /> <span>Điều chỉnh</span>
        </button>
      )}

      <Sheet open={pickOpen} onClose={() => setPickOpen(false)} title="Chọn hàng để điều chỉnh">
        {products.length === 0 ? (
          <div className="muted" style={{ padding: 16 }}>Không có sản phẩm.</div>
        ) : (
          <div className="stack">
            {products.map((p) => (
              <button key={p.productId} className="card card--flat inv-row" onClick={() => openAdjust(p)}>
                <div className="catalog-row__main"><div className="inv-row__name">{p.name}</div><div className="muted tiny">{unitLabel(p.unitCode)}</div></div>
                <div className="inv-row__stock"><span className="inv-row__qty">{fmtQty(p.onHand)}</span><span className="muted tiny">tồn</span></div>
              </button>
            ))}
          </div>
        )}
      </Sheet>

      <AdjustSheet open={Boolean(adjustTarget)} onClose={() => setAdjustTarget(null)} merchantId={merchantId}
        target={adjustTarget} onDone={() => { setAdjustTarget(null); load(); }} />
    </div>
  );
}
