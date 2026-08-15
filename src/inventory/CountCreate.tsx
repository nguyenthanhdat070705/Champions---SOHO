// "Tạo phiên kiểm kho" (spec 3.5). Pick a simple scope (all / a category / a hand-
// picked set), name it, and choose blind counting (default ON so the counter isn't
// biased by the system number). Starting the session snapshots expected_at_start
// for every item server-side (kept even if sales happen afterwards).
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader, Button, TextField } from "../components/ui";
import { InlineError } from "../sales/ui";
import { IconSearch } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import type { Category, ApiProduct, CountScope } from "../lib/api";
import { useDebounced } from "../catalog/parts";
import { fmtQty } from "../lib/inventory";
import { unitLabel } from "../lib/catalog";

type ScopeMode = "all" | "category" | "products";

export function CountCreate() {
  const nav = useNavigate();
  const { merchant } = useMerchant();
  const merchantId = merchant?.id ?? "";

  const today = new Date().toLocaleDateString("vi-VN");
  const [name, setName] = useState(`Kiểm kho ${today}`);
  const [blind, setBlind] = useState(true);
  const [mode, setMode] = useState<ScopeMode>("all");
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState<string>("");
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debouncedSearch = useDebounced(search, 280);

  useEffect(() => {
    if (!merchantId) return;
    api.listCategories(merchantId).then((r) => setCategories(r.categories)).catch(() => {});
  }, [merchantId]);

  useEffect(() => {
    if (!merchantId || mode !== "products") return;
    api.catalogList(merchantId, { search: debouncedSearch.trim() || undefined, type: "goods", status: "active", limit: 200 })
      .then((r) => setProducts(r.products.filter((p) => p.trackInventory)))
      .catch(() => setProducts([]));
  }, [merchantId, mode, debouncedSearch]);

  function togglePick(id: string) {
    setPicked((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function buildScope(): CountScope | null {
    if (mode === "all") return { type: "all" };
    if (mode === "category") return categoryId ? { type: "category", categoryId } : null;
    return picked.size > 0 ? { type: "products", productIds: [...picked] } : null;
  }

  async function start() {
    const scope = buildScope();
    if (!scope || busy) { if (!scope) setError("Hãy chọn phạm vi kiểm kho."); return; }
    setBusy(true); setError(null);
    try {
      const r = await api.countCreate(merchantId, { name: name.trim() || `Kiểm kho ${today}`, blindCount: blind, scope }, newIdempotencyKey());
      nav(`/ton-kho/kiem-kho/${r.session.id}`, { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tạo được phiên kiểm kho.");
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <PageHeader title="Tạo phiên kiểm kho" onBack={() => nav("/ton-kho")} />
      <div className="content--plain stack">
        {error && <InlineError message={error} onClose={() => setError(null)} />}

        <TextField label="Tên phiên" value={name} onChange={setName} placeholder={`Kiểm kho ${today}`} />

        <div className="field">
          <label className="field__label">Phạm vi<span className="field__req"> *</span></label>
          <div className="segment">
            <button className={`segment__btn ${mode === "all" ? "segment__btn--on" : ""}`} onClick={() => setMode("all")}>Tất cả</button>
            <button className={`segment__btn ${mode === "category" ? "segment__btn--on" : ""}`} onClick={() => setMode("category")}>Theo nhóm</button>
            <button className={`segment__btn ${mode === "products" ? "segment__btn--on" : ""}`} onClick={() => setMode("products")}>Chọn hàng</button>
          </div>
        </div>

        {mode === "category" && (
          <div className="seg-scroll" style={{ paddingLeft: 0 }}>
            {categories.length === 0 && <span className="muted tiny">Chưa có nhóm hàng.</span>}
            {categories.map((c) => (
              <button key={c.id} className={`chip ${categoryId === c.id ? "chip--on" : ""}`} onClick={() => setCategoryId(c.id)}>{c.name}</button>
            ))}
          </div>
        )}

        {mode === "products" && (
          <>
            <div className="pos-search" style={{ padding: 0 }}>
              <div className="pos-search__box">
                <IconSearch size={19} />
                <input className="pos-search__input" placeholder="Tìm hàng theo dõi tồn…" value={search} onChange={(e) => setSearch(e.target.value)} inputMode="search" />
              </div>
            </div>
            <div className="muted tiny">Đã chọn {picked.size} sản phẩm</div>
            <div className="stack">
              {products.map((p) => (
                <button key={p.id} className={`card card--flat inv-row ${picked.has(p.id) ? "inv-row--picked" : ""}`} onClick={() => togglePick(p.id)}>
                  <div className="catalog-row__main"><div className="inv-row__name">{p.name}</div><div className="muted tiny">{unitLabel(p.unitCode)}{p.sku ? ` · ${p.sku}` : ""}</div></div>
                  <div className="inv-row__stock"><span className="inv-row__qty">{fmtQty(p.onHand)}</span><span className="muted tiny">{picked.has(p.id) ? "✓ chọn" : "tồn"}</span></div>
                </button>
              ))}
            </div>
          </>
        )}

        <div className="checkrow" onClick={() => setBlind((v) => !v)} role="switch" aria-checked={blind} style={{ marginTop: 4 }}>
          <div className={`switch ${blind ? "switch--on" : ""}`}><span className="switch__dot" /></div>
          <div className="checkrow__text">
            <div style={{ fontWeight: 700 }}>Ẩn số hệ thống (đếm mù)</div>
            <div className="muted tiny">Không hiện số tồn khi nhập để tránh ảnh hưởng người đếm.</div>
          </div>
        </div>
      </div>

      <div className="form-foot">
        <Button variant="primary" loading={busy} onClick={start}>Bắt đầu kiểm kho</Button>
      </div>
    </div>
  );
}
