// "Tạo bill — Chọn hàng" (spec 3.2): debounced search, product grid with a
// tap-to-add + inline stepper, quick-create and camera-scan entry points, and a
// fixed "Xem giỏ" CTA showing the server-backed running total.
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { ApiProduct } from "../lib/api";
import { formatVnd } from "../lib/format";
import { IconBack, IconCamera, IconCart, IconMinus, IconPlus, IconSearch } from "../components/icons";
import type { CartState } from "./cartStore";

function qtyInCart(cart: CartState, productId: string): number {
  return cart.lines.find((l) => l.productId === productId)?.quantity ?? 0;
}
function lineIndex(cart: CartState, productId: string): number {
  return cart.lines.findIndex((l) => l.productId === productId);
}
function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n).replace(/\.?0+$/, "");
}

export function ProductPicker({
  merchantId, cart, total, count, previewBusy,
  onAdd, onInc, onDec, onClose, onOpenScan, onOpenQuick, onViewCart, onClear,
}: {
  merchantId: string;
  cart: CartState;
  total: number;
  count: number;
  previewBusy: boolean;
  onAdd: (p: ApiProduct) => void;
  onInc: (index: number) => void;
  onDec: (index: number) => void;
  onClose: () => void;
  onOpenScan: () => void;
  onOpenQuick: (barcode?: string) => void;
  onViewCart: () => void;
  onClear: () => void;
}) {
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.listProducts(merchantId)
      .then((r) => { if (active) setProducts(r.products); })
      .catch(() => { if (active) setProducts([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [merchantId]);

  // Reload after a quick-create adds a product (cart change is a good proxy).
  useEffect(() => {
    const known = new Set(products.map((p) => p.id));
    const missing = cart.lines.some((l) => l.productId && !known.has(l.productId));
    if (missing) {
      api.listProducts(merchantId).then((r) => setProducts(r.products)).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.lines.length]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) =>
      p.name.toLowerCase().includes(q) || (p.sku ?? "").toLowerCase().includes(q) || (p.barcode ?? "") === search.trim());
  }, [products, search]);

  return (
    <div className="screen pos-screen">
      <div className="pos-top">
        <button className="step__back" onClick={onClose} aria-label="Đóng"><IconBack size={20} /></button>
        <div className="pos-top__title">Tạo bill</div>
        <div style={{ position: "relative" }}>
          <button className="step__back" onClick={() => setMenuOpen((v) => !v)} aria-label="Thêm">⋯</button>
          {menuOpen && (
            <div className="pos-menu" onMouseLeave={() => setMenuOpen(false)}>
              <button onClick={() => { setMenuOpen(false); onClear(); }}>Xóa hết giỏ</button>
            </div>
          )}
        </div>
      </div>

      <div className="pos-search">
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
        <button className="pos-search__scan" onClick={onOpenScan} aria-label="Quét mã vạch"><IconCamera size={20} /></button>
      </div>

      <button className="pos-quick-add" onClick={() => onOpenQuick(undefined)}>
        <IconPlus size={16} /> Tạo hàng nhanh
      </button>

      <div className="pos-grid">
        {loading ? (
          <div className="muted" style={{ gridColumn: "1 / -1", textAlign: "center", padding: 30 }}>Đang tải danh mục…</div>
        ) : filtered.length === 0 ? (
          <div className="empty" style={{ gridColumn: "1 / -1" }}>
            <div className="empty__ic"><IconCart size={26} /></div>
            <div className="empty__t">{search ? "Không tìm thấy sản phẩm" : "Chưa có sản phẩm"}</div>
            <div className="empty__d">Bấm “Tạo hàng nhanh” để thêm mặt hàng mới rồi bán ngay.</div>
          </div>
        ) : (
          filtered.map((p) => {
            const qty = qtyInCart(cart, p.id);
            const idx = lineIndex(cart, p.id);
            const soldOut = p.trackInventory && p.onHand != null && p.onHand <= 0;
            const low =
              p.trackInventory && !soldOut && p.onHand != null &&
              p.lowStockThreshold != null && p.onHand <= p.lowStockThreshold;
            return (
              <div key={p.id} className={`prod ${soldOut ? "prod--out" : ""}`}>
                <button className="prod__tap" disabled={soldOut} onClick={() => onAdd(p)}>
                  <div className="prod__name">{p.name}</div>
                  <div className="prod__price">{formatVnd(p.salePrice)}</div>
                  {p.trackInventory && (
                    <div className={`prod__stock ${soldOut ? "prod__stock--out" : low ? "prod__stock--low" : ""}`}>
                      {soldOut ? "Hết hàng" : `Tồn ${fmtQty(p.onHand ?? 0)}`}
                    </div>
                  )}
                </button>
                {qty > 0 && (
                  <div className="prod__stepper">
                    <button onClick={() => onDec(idx)} aria-label="Bớt"><IconMinus size={16} /></button>
                    <span>{fmtQty(qty)}</span>
                    <button onClick={() => onInc(idx)} disabled={p.trackInventory && p.onHand != null && qty >= p.onHand} aria-label="Thêm"><IconPlus size={16} /></button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {count > 0 && (
        <button className="pos-cta" onClick={onViewCart}>
          <span className="pos-cta__badge">{count}</span>
          <span>Xem giỏ</span>
          <span className="pos-cta__total">{previewBusy ? "…" : formatVnd(total)}</span>
        </button>
      )}
    </div>
  );
}
