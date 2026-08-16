// Functional 06 shared UI: the "cách nhập" chooser (spec 3.2), supplier picker +
// quick-create (spec 3.3), a catalog product picker, the per-line edit sheet
// (spec 3.4), and the AI/OCR review sheet where the user matches each extracted
// line to a product before it can be used (spec 3.6 — never auto-post).
import { useEffect, useRef, useState } from "react";
import { Sheet, InlineError } from "../sales/ui";
import { Button } from "../components/ui";
import { IconCamera, IconEdit, IconSearch, IconChevron } from "../components/icons";
import { api, ApiError } from "../lib/api";
import type { Supplier, ApiProduct, ExtractedLine, DocumentExtraction } from "../lib/api";
import { useDebounced, ConfidenceBadge } from "../catalog/parts";
import { unitLabel } from "../lib/catalog";
import { formatVnd } from "../lib/format";
import { parseQty, parseCost, lineTotal } from "../lib/receiving";

// ── "Chọn cách nhập" (spec 3.2) ───────────────────────────────────────────────
export function MethodChooserSheet({
  open, onClose, onManual, onPhoto, busy,
}: {
  open: boolean; onClose: () => void; onManual: () => void; onPhoto: (file: File) => void; busy: boolean;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  return (
    <Sheet open={open} onClose={onClose} title="Nhập hàng mới">
      <div className="muted tiny" style={{ marginBottom: 12 }}>Chụp chứng từ để AI dựng sẵn phiếu, hoặc nhập tay.</div>
      <div className="stack">
        <button className="opt" onClick={() => !busy && fileRef.current?.click()} disabled={busy}>
          <span className="opt__icon">{busy ? <span className="spinner spinner--sm" /> : <IconCamera size={22} />}</span>
          <span className="opt__body">
            <span className="opt__label">{busy ? "Đang đọc chứng từ…" : "Chụp chứng từ"}</span>
            <span className="opt__hint">AI đọc nhà cung cấp, ngày và các dòng hàng. Bạn luôn kiểm tra lại.</span>
          </span>
        </button>
        <button className="opt" onClick={onManual} disabled={busy}>
          <span className="opt__icon"><IconEdit size={20} /></span>
          <span className="opt__body">
            <span className="opt__label">Nhập tay</span>
            <span className="opt__hint">Tự chọn hàng, số lượng và đơn giá.</span>
          </span>
        </button>
      </div>
      <div className="field__hint" style={{ marginTop: 10 }}>Chụp ảnh không đồng nghĩa đã ghi sổ — bạn xác nhận ở bước cuối.</div>
      <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onPhoto(f); }} />
    </Sheet>
  );
}

// ── Supplier picker + quick-create (spec 3.3) ─────────────────────────────────
export function SupplierPickerSheet({
  open, merchantId, value, onClose, onPick,
}: {
  open: boolean; merchantId: string; value: string | null;
  onClose: () => void; onPick: (s: { id: string | null; name: string | null }) => void;
}) {
  const [search, setSearch] = useState("");
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounced = useDebounced(search, 250);

  useEffect(() => {
    if (!open || !merchantId) return;
    api.listSuppliers(merchantId, debounced.trim() || undefined).then((r) => setSuppliers(r.suppliers)).catch(() => {});
  }, [open, merchantId, debounced]);
  useEffect(() => { if (open) { setNewName(""); setError(null); } }, [open]);

  async function create() {
    const n = newName.trim();
    if (!n || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await api.createSupplier(merchantId, { name: n });
      onPick({ id: r.supplier.id, name: r.supplier.name });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tạo được nhà cung cấp.");
    } finally { setBusy(false); }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Nhà cung cấp">
      {error && <InlineError message={error} onClose={() => setError(null)} />}
      <div className="pos-search" style={{ padding: 0, marginBottom: 10 }}>
        <div className="pos-search__box"><IconSearch size={18} />
          <input className="pos-search__input" placeholder="Tìm nhà cung cấp…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      </div>
      <div className="cat-picker">
        <button className={`cat-picker__row ${value == null ? "cat-picker__row--on" : ""}`} onClick={() => { onPick({ id: null, name: null }); onClose(); }}>Không ghi nhà cung cấp</button>
        {suppliers.map((s) => (
          <button key={s.id} className="cat-picker__row" onClick={() => { onPick({ id: s.id, name: s.name }); onClose(); }}>{s.name}</button>
        ))}
      </div>
      <div className="field" style={{ marginTop: 14 }}>
        <label className="field__label">Thêm nhà cung cấp mới</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="VD: Nhà phân phối ABC" maxLength={160} />
          <button className="btn btn--outline" style={{ width: "auto", padding: "0 18px" }} disabled={!newName.trim() || busy} onClick={create}>
            {busy ? <span className="spinner spinner--sm" /> : "Thêm"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

// ── Catalog product picker (tracked goods only) ───────────────────────────────
export function ProductPickerSheet({
  open, merchantId, excludeIds, onClose, onPick,
}: {
  open: boolean; merchantId: string; excludeIds: string[];
  onClose: () => void; onPick: (p: ApiProduct) => void;
}) {
  const [search, setSearch] = useState("");
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const debounced = useDebounced(search, 250);

  useEffect(() => {
    if (!open || !merchantId) return;
    setLoading(true);
    api.catalogList(merchantId, { search: debounced.trim() || undefined, type: "goods", status: "active", limit: 50 })
      .then((r) => setProducts(r.products.filter((p) => p.trackInventory)))
      .catch(() => setProducts([]))
      .finally(() => setLoading(false));
  }, [open, merchantId, debounced]);
  useEffect(() => { if (open) setSearch(""); }, [open]);

  const list = products.filter((p) => !excludeIds.includes(p.id));

  return (
    <Sheet open={open} onClose={onClose} title="Chọn hàng nhập">
      <div className="pos-search" style={{ padding: 0, marginBottom: 10 }}>
        <div className="pos-search__box"><IconSearch size={18} />
          <input className="pos-search__input" placeholder="Tìm tên hoặc SKU…" value={search} onChange={(e) => setSearch(e.target.value)} inputMode="search" /></div>
      </div>
      {loading ? (
        <div className="muted" style={{ textAlign: "center", padding: 20 }}>Đang tải…</div>
      ) : list.length === 0 ? (
        <div className="muted" style={{ padding: 16 }}>
          {search ? "Không tìm thấy hàng theo dõi tồn." : "Chưa có hàng theo dõi tồn."}
          <div className="field__hint">Chỉ hàng hóa bật “Theo dõi tồn” mới nhập được.</div>
        </div>
      ) : (
        <div className="stack">
          {list.map((p) => (
            <button key={p.id} className="card card--flat inv-row" onClick={() => onPick(p)}>
              <div className="catalog-row__main">
                <div className="inv-row__name">{p.name}</div>
                <div className="muted tiny">{unitLabel(p.unitCode)}{p.sku ? ` · ${p.sku}` : ""}{p.onHand != null ? ` · tồn ${p.onHand}` : ""}</div>
              </div>
              <IconChevron size={16} />
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}

// ── Per-line edit sheet (spec 3.4) ────────────────────────────────────────────
export interface DraftLine {
  productId: string; name: string; unitCode: string; quantity: string; unitCost: string;
  matchSource?: string; matchConfidence?: number | null;
}

export function LineEditSheet({
  open, line, onClose, onSave, onRemove,
}: {
  open: boolean; line: DraftLine | null;
  onClose: () => void; onSave: (l: DraftLine) => void; onRemove?: () => void;
}) {
  const [quantity, setQuantity] = useState("");
  const [unitCost, setUnitCost] = useState("");
  useEffect(() => { if (line) { setQuantity(line.quantity || ""); setUnitCost(line.unitCost || ""); } }, [line]);

  const q = parseQty(quantity);
  const c = parseCost(unitCost);
  const valid = q != null && c != null;
  const total = valid ? lineTotal(q as number, c as number) : 0;

  if (!open || !line) return null;
  return (
    <Sheet open={open} onClose={onClose} title={line.name}
      footer={
        <div style={{ display: "flex", gap: 10 }}>
          {onRemove && <button className="btn btn--outline" onClick={onRemove} style={{ flex: 1 }}>Xóa dòng</button>}
          <div style={{ flex: 2 }}>
            <Button variant="primary" disabled={!valid} disabledReason={!valid ? "Nhập số lượng và đơn giá." : undefined}
              onClick={() => onSave({ ...line, quantity, unitCost })}>Lưu dòng</Button>
          </div>
        </div>
      }>
      <div className="muted tiny" style={{ marginBottom: 10 }}>{unitLabel(line.unitCode)}</div>
      <div className="field">
        <label className="field__label">Số lượng <span className="field__req">*</span></label>
        <input className="input" inputMode="decimal" placeholder="0" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        {quantity !== "" && q == null && <div className="field__error">Số lượng phải lớn hơn 0.</div>}
      </div>
      <div className="field">
        <label className="field__label">Đơn giá nhập (VND) <span className="field__req">*</span></label>
        <input className="input" inputMode="numeric" placeholder="0" value={unitCost}
          onChange={(e) => setUnitCost(e.target.value.replace(/\D/g, ""))} />
        {unitCost !== "" && c != null ? <div className="field__hint">{formatVnd(c)}</div> : null}
      </div>
      <div className="kv" style={{ marginTop: 6 }}><span>Thành tiền</span><b>{formatVnd(total)}</b></div>
    </Sheet>
  );
}

// ── AI/OCR review sheet (spec 3.6) ────────────────────────────────────────────
// Each extracted line must be matched to a product (from AI candidates or a manual
// search) before it can be used; unmatched lines are skipped, never auto-posted.
interface ReviewRow { key: number; line: ExtractedLine; productId: string | null; productName: string | null; quantity: string; unitCost: string; }

export function ExtractionReviewSheet({
  open, merchantId, extraction, onClose, onUse,
}: {
  open: boolean; merchantId: string; extraction: DocumentExtraction | null;
  onClose: () => void; onUse: (lines: DraftLine[]) => void;
}) {
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [pickFor, setPickFor] = useState<number | null>(null);
  const [productUnits, setProductUnits] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open || !extraction) return;
    setRows(extraction.lines.map((l, i) => ({
      key: i, line: l,
      productId: l.match?.productId ?? null,
      productName: l.match?.productId ? (l.match?.name ?? null) : null,
      quantity: l.quantity != null ? String(l.quantity) : "",
      unitCost: l.unitCostVnd != null ? String(l.unitCostVnd) : "",
    })));
    const units: Record<string, string> = {};
    for (const l of extraction.lines) for (const c of l.match?.candidates ?? []) units[c.productId] = c.unitCode;
    setProductUnits(units);
  }, [open, extraction]);

  const resolvedCount = rows.filter((r) => r.productId && parseQty(r.quantity) != null && parseCost(r.unitCost) != null).length;
  const unresolved = rows.filter((r) => !r.productId).length;

  function patchRow(key: number, patch: Partial<ReviewRow>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function use() {
    const out: DraftLine[] = [];
    for (const r of rows) {
      const q = parseQty(r.quantity), c = parseCost(r.unitCost);
      if (!r.productId || q == null || c == null) continue;
      out.push({
        productId: r.productId,
        name: r.productName ?? "",
        unitCode: productUnits[r.productId] ?? "",
        quantity: r.quantity, unitCost: r.unitCost,
        matchSource: "ai", matchConfidence: r.line.match?.confidence ?? null,
      });
    }
    onUse(out);
  }

  if (!open || !extraction) return null;
  return (
    <>
      <Sheet open={open} onClose={onClose} title="Kiểm tra kết quả AI"
        footer={
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn--outline" onClick={onClose} style={{ flex: 1 }}>Nhập tay</button>
            <div style={{ flex: 2 }}>
              <Button variant="primary" disabled={resolvedCount === 0}
                disabledReason={resolvedCount === 0 ? "Ghép ít nhất một dòng với sản phẩm." : undefined}
                onClick={use}>Dùng {resolvedCount} dòng</Button>
            </div>
          </div>
        }>
        <div className="muted tiny" style={{ marginBottom: 8 }}>
          AI chỉ gợi ý. Ghép mỗi dòng với đúng sản phẩm rồi kiểm tra số lượng, đơn giá.
          {unresolved > 0 ? ` Còn ${unresolved} dòng chưa ghép sẽ bị bỏ qua.` : ""}
        </div>
        {extraction.warnings.length > 0 && <div className="banner banner--warn" style={{ marginBottom: 10 }}>{extraction.warnings.join(" ")}</div>}
        {rows.length === 0 ? (
          <div className="muted" style={{ padding: 12 }}>AI không đọc được dòng hàng nào. Bạn có thể nhập tay.</div>
        ) : (
          <div className="stack">
            {rows.map((r) => {
              const matched = Boolean(r.productId);
              return (
                <div key={r.key} className={`card card--flat ${matched ? "" : "rcpt-line--warn"}`} style={{ padding: 12 }}>
                  <div className="rcpt-review__desc">“{r.line.description}” <ConfidenceBadge value={r.line.match?.confidence ?? r.line.confidence} /></div>
                  <button className="input input--select" style={{ marginTop: 6 }} onClick={() => setPickFor(r.key)}>
                    {matched ? r.productName : "Chọn sản phẩm để ghép…"}
                  </button>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <div className="field" style={{ flex: 1, margin: 0 }}>
                      <label className="field__label tiny">Số lượng</label>
                      <input className="input" inputMode="decimal" placeholder="0" value={r.quantity} onChange={(e) => patchRow(r.key, { quantity: e.target.value })} />
                    </div>
                    <div className="field" style={{ flex: 1, margin: 0 }}>
                      <label className="field__label tiny">Đơn giá</label>
                      <input className="input" inputMode="numeric" placeholder="0" value={r.unitCost} onChange={(e) => patchRow(r.key, { unitCost: e.target.value.replace(/\D/g, "") })} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Sheet>

      <ProductPickerSheet
        open={pickFor != null} merchantId={merchantId} excludeIds={rows.filter((r) => r.key !== pickFor && r.productId).map((r) => r.productId as string)}
        onClose={() => setPickFor(null)}
        onPick={(p) => {
          setProductUnits((u) => ({ ...u, [p.id]: p.unitCode }));
          patchRow(pickFor as number, { productId: p.id, productName: p.name });
          setPickFor(null);
        }}
      />
    </>
  );
}
