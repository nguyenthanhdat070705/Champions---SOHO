// "Kho" — real product list with price + on-hand from products/inventory_levels
// (spec brief scope 7; nhập hàng is not in MVP, so this is read-only). Low-stock
// rows are flagged. Reads are RLS-scoped through the server API.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/ui";
import { IconBox, IconSearch } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api } from "../lib/api";
import type { ApiProduct } from "../lib/api";
import { formatVnd } from "../lib/format";

function fmtQty(n: number | null): string {
  if (n == null) return "—";
  return Number.isInteger(n) ? String(n) : String(n).replace(/\.?0+$/, "");
}

export function InventoryPage() {
  const nav = useNavigate();
  const { merchant } = useMerchant();
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!merchant) return;
    let active = true;
    setLoading(true);
    api.listProducts(merchant.id)
      .then((r) => { if (active) setProducts(r.products); })
      .catch(() => { if (active) setProducts([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [merchant]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) => p.name.toLowerCase().includes(q) || (p.sku ?? "").toLowerCase().includes(q));
  }, [products, search]);

  const lowCount = products.filter((p) => p.trackInventory && p.onHand != null && p.lowStockThreshold != null && p.onHand <= p.lowStockThreshold).length;

  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Kho hàng" onBack={() => nav("/")} />
      <div className="content--plain">
        <div className="pos-search" style={{ padding: 0, marginBottom: 12 }}>
          <div className="pos-search__box">
            <IconSearch size={19} />
            <input className="pos-search__input" placeholder="Tìm sản phẩm…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>

        {lowCount > 0 && (
          <div className="banner banner--warn" style={{ marginBottom: 12 }}>{lowCount} sản phẩm ở mức tồn kho thấp.</div>
        )}

        {loading ? (
          <div className="muted" style={{ textAlign: "center", padding: 30 }}>Đang tải…</div>
        ) : filtered.length === 0 ? (
          <div className="empty">
            <div className="empty__ic"><IconBox size={28} /></div>
            <div className="empty__t">Chưa có mặt hàng</div>
            <div className="empty__d">Thêm sản phẩm khi tạo bill (Tạo hàng nhanh) để chúng xuất hiện ở đây.</div>
          </div>
        ) : (
          <div className="stack">
            {filtered.map((p) => {
              const low = p.trackInventory && p.onHand != null && p.lowStockThreshold != null && p.onHand <= p.lowStockThreshold;
              return (
                <div key={p.id} className="card card--flat inv-row">
                  <div>
                    <div className="inv-row__name">{p.name}</div>
                    <div className="muted tiny">{formatVnd(p.salePrice)} · {p.unitCode}{p.sku ? ` · ${p.sku}` : ""}</div>
                  </div>
                  <div className="inv-row__stock">
                    {p.trackInventory ? (
                      <>
                        <span className={`inv-row__qty ${low ? "inv-row__qty--low" : ""}`}>{fmtQty(p.onHand)}</span>
                        <span className="muted tiny">tồn</span>
                      </>
                    ) : (
                      <span className="muted tiny">Không theo dõi</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
