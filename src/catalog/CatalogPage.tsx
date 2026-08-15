// "Hàng hóa & dịch vụ" — the Kho screen is now full catalog management (spec 3.1).
// Searchable (unaccented, server-side) list with a status segment, type + category
// chips, a scan entry, and a FAB that opens the "Chọn loại cần tạo" sheet. Archived
// products are hidden by default; the "Lưu trữ" filter reveals them (spec 3.1).
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/ui";
import { IconBox, IconSearch, IconCamera, IconPlus } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api } from "../lib/api";
import type { ApiProduct, Category } from "../lib/api";
import { formatVnd } from "../lib/format";
import { STATUS_LABEL, unitLabel } from "../lib/catalog";
import { useDebounced, TypeChooserSheet } from "./parts";
import { ScanSheet } from "../sales/sheets";

type StatusTab = "active" | "inactive" | "archived" | "all";
const STATUS_TABS: { key: StatusTab; label: string }[] = [
  { key: "active", label: "Đang bán" },
  { key: "inactive", label: "Tạm ngừng" },
  { key: "archived", label: "Lưu trữ" },
  { key: "all", label: "Tất cả" },
];

function fmtQty(n: number | null): string {
  if (n == null) return "—";
  return Number.isInteger(n) ? String(n) : String(n).replace(/\.?0+$/, "");
}

export function CatalogPage() {
  const nav = useNavigate();
  const { merchant } = useMerchant();
  const merchantId = merchant?.id ?? "";

  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusTab, setStatusTab] = useState<StatusTab>("active");
  const [typeFilter, setTypeFilter] = useState<"" | "goods" | "service">("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [chooseOpen, setChooseOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);

  const debouncedSearch = useDebounced(search, 280);

  useEffect(() => {
    if (!merchantId) return;
    api.listCategories(merchantId).then((r) => setCategories(r.categories)).catch(() => {});
  }, [merchantId]);

  useEffect(() => {
    if (!merchantId) return;
    let active = true;
    setLoading(true);
    api.catalogList(merchantId, {
      search: debouncedSearch.trim() || undefined,
      status: statusTab,
      type: typeFilter || undefined,
      category: categoryId || undefined,
      includeArchived: statusTab === "all",
      limit: 200,
    })
      .then((r) => { if (active) setProducts(r.products); })
      .catch(() => { if (active) setProducts([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [merchantId, debouncedSearch, statusTab, typeFilter, categoryId]);

  const lowCount = useMemo(
    () => products.filter((p) => p.trackInventory && p.onHand != null && p.lowStockThreshold != null && p.onHand <= p.lowStockThreshold).length,
    [products],
  );

  function openCreate(type: "goods" | "service") {
    setChooseOpen(false);
    nav(`/kho/moi?type=${type}`);
  }

  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Hàng hóa & dịch vụ" onBack={() => nav("/")}
        right={
          <button className="step__back" aria-label="Tồn kho" onClick={() => nav("/ton-kho")}>
            <IconBox size={19} />
          </button>
        } />
      <div className="content--plain catalog">
        <div className="pos-search" style={{ padding: 0, marginBottom: 10 }}>
          <div className="pos-search__box">
            <IconSearch size={19} />
            <input
              className="pos-search__input"
              placeholder="Tìm tên, SKU hoặc mã vạch…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              inputMode="search"
            />
          </div>
          <button className="pos-search__scan" onClick={() => setScanOpen(true)} aria-label="Quét mã vạch"><IconCamera size={20} /></button>
        </div>

        <div className="seg-scroll">
          {STATUS_TABS.map((t) => (
            <button key={t.key} className={`chip ${statusTab === t.key ? "chip--on" : ""}`} onClick={() => setStatusTab(t.key)}>{t.label}</button>
          ))}
          <span className="seg-scroll__sep" />
          {(["", "goods", "service"] as const).map((t) => (
            <button key={t || "all"} className={`chip ${typeFilter === t ? "chip--on" : ""}`} onClick={() => setTypeFilter(t)}>
              {t === "" ? "Tất cả loại" : t === "goods" ? "Hàng hóa" : "Dịch vụ"}
            </button>
          ))}
        </div>

        {categories.length > 0 && (
          <div className="seg-scroll" style={{ marginTop: 2 }}>
            <button className={`chip ${categoryId == null ? "chip--on" : ""}`} onClick={() => setCategoryId(null)}>Mọi nhóm</button>
            {categories.map((c) => (
              <button key={c.id} className={`chip ${categoryId === c.id ? "chip--on" : ""}`} onClick={() => setCategoryId(c.id)}>{c.name}</button>
            ))}
          </div>
        )}

        {lowCount > 0 && statusTab === "active" && (
          <button className="banner banner--warn banner--tap" style={{ marginTop: 12 }} onClick={() => nav("/ton-kho?filter=low")}>
            {lowCount} sản phẩm ở mức tồn kho thấp. <span className="banner__cta">Xem tồn kho ›</span>
          </button>
        )}

        {loading ? (
          <div className="muted" style={{ textAlign: "center", padding: 30 }}>Đang tải…</div>
        ) : products.length === 0 ? (
          <div className="empty" style={{ marginTop: 20 }}>
            <div className="empty__ic"><IconBox size={28} /></div>
            <div className="empty__t">{search ? "Không tìm thấy" : "Chưa có mặt hàng"}</div>
            <div className="empty__d">{search ? "Thử từ khóa khác hoặc quét mã vạch." : "Bấm “+ Thêm” để tạo hàng hóa hoặc dịch vụ đầu tiên."}</div>
          </div>
        ) : (
          <div className="stack" style={{ marginTop: 12 }}>
            {products.map((p) => {
              const low = p.trackInventory && p.onHand != null && p.lowStockThreshold != null && p.onHand <= p.lowStockThreshold;
              return (
                <button key={p.id} className="card card--flat inv-row catalog-row" onClick={() => nav(`/kho/${p.id}`)}>
                  <div className="catalog-row__main">
                    <div className="inv-row__name">
                      {p.name}
                      {p.status && p.status !== "active" && <span className={`pill pill--${p.status}`}>{STATUS_LABEL[p.status]}</span>}
                    </div>
                    <div className="muted tiny">
                      {formatVnd(p.salePrice)} · {unitLabel(p.unitCode)}
                      {p.sku ? ` · ${p.sku}` : ""}
                    </div>
                  </div>
                  <div className="inv-row__stock">
                    {p.trackInventory ? (
                      <>
                        <span className={`inv-row__qty ${low ? "inv-row__qty--low" : ""}`}>{fmtQty(p.onHand)}</span>
                        <span className="muted tiny">tồn</span>
                      </>
                    ) : (
                      <span className="muted tiny">{p.productType === "service" ? "Dịch vụ" : "Không theo dõi"}</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <button className="fab" onClick={() => setChooseOpen(true)} aria-label="Thêm mới">
        <IconPlus size={22} /> <span>Thêm</span>
      </button>

      <TypeChooserSheet open={chooseOpen} onClose={() => setChooseOpen(false)} onPick={openCreate} />
      <ScanSheet
        open={scanOpen}
        merchantId={merchantId}
        onClose={() => setScanOpen(false)}
        onFound={(p) => { setScanOpen(false); nav(`/kho/${p.id}`); }}
        onNotFound={(code) => { setScanOpen(false); nav(`/kho/moi?type=goods&barcode=${encodeURIComponent(code)}`); }}
      />
    </div>
  );
}
