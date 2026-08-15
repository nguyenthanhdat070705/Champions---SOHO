// Small shared pieces for the Functional 04 catalog screens: a category
// picker/quick-create sheet (spec 3.3 "Tạo nhóm nhanh"), the "Chọn loại cần tạo"
// sheet (spec 3.2), a confidence badge for AI-suggested fields (spec 3.6), and a
// debounce hook for the search box (spec 3.1 debounce 250–300ms).
import { useEffect, useState } from "react";
import { Sheet, InlineError } from "../sales/ui";
import { OptionCard } from "../components/ui";
import { IconBox, IconSparkle } from "../components/icons";
import { api, ApiError } from "../lib/api";
import type { Category } from "../lib/api";
import type { ProductType } from "../lib/catalog";

export function useDebounced<T>(value: T, delay = 280): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

/** Read a File to raw base64 (no data: prefix) + its mime type. */
export function fileToBase64(file: File): Promise<{ base64: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      const i = s.indexOf(",");
      resolve({ base64: i >= 0 ? s.slice(i + 1) : s, mimeType: file.type || "image/jpeg" });
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ── Type chooser (spec 3.2) ───────────────────────────────────────────────────
export function TypeChooserSheet({
  open, onClose, onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (t: ProductType) => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Thêm mới">
      <div className="muted tiny" style={{ marginBottom: 12 }}>Chọn loại cần tạo</div>
      <div className="stack">
        <OptionCard
          icon={<IconBox size={22} />}
          label="Hàng hóa"
          hint="Sản phẩm có thể theo dõi tồn kho (nước, bánh, gạo…)"
          selected={false}
          onSelect={() => onPick("goods")}
        />
        <OptionCard
          icon={<IconSparkle size={22} />}
          label="Dịch vụ"
          hint="Bán theo lần/gói, không có tồn kho (cắt tóc, giặt ủi…)"
          selected={false}
          onSelect={() => onPick("service")}
        />
      </div>
    </Sheet>
  );
}

// ── Category picker + quick-create (spec 3.3) ─────────────────────────────────
export function CategoryPickerSheet({
  open, merchantId, categories, value, onClose, onSelect, onCreated,
}: {
  open: boolean;
  merchantId: string;
  categories: Category[];
  value: string | null;
  onClose: () => void;
  onSelect: (id: string | null) => void;
  onCreated: (c: Category) => void;
}) {
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (open) { setNewName(""); setError(null); } }, [open]);

  async function create() {
    const n = newName.trim();
    if (!n || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await api.createCategory(merchantId, n);
      onCreated(res.category);
      onSelect(res.category.id);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tạo được nhóm.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Nhóm hàng">
      {error && <InlineError message={error} onClose={() => setError(null)} />}
      <div className="cat-picker">
        <button className={`cat-picker__row ${value == null ? "cat-picker__row--on" : ""}`} onClick={() => { onSelect(null); onClose(); }}>
          Không phân nhóm
        </button>
        {categories.map((c) => (
          <button key={c.id} className={`cat-picker__row ${value === c.id ? "cat-picker__row--on" : ""}`} onClick={() => { onSelect(c.id); onClose(); }}>
            {c.name}
          </button>
        ))}
      </div>
      <div className="field" style={{ marginTop: 14 }}>
        <label className="field__label">Tạo nhóm nhanh</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="VD: Đồ uống" maxLength={60} />
          <button className="btn btn--outline" style={{ width: "auto", padding: "0 18px" }} disabled={!newName.trim() || busy} onClick={create}>
            {busy ? <span className="spinner spinner--sm" /> : "Tạo"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

// ── AI confidence badge (spec 3.6 — mark AI-inferred fields) ───────────────────
export function ConfidenceBadge({ value }: { value: number | null | undefined }) {
  if (value == null) return null;
  const pct = Math.round(value * 100);
  const level = value >= 0.75 ? "good" : value >= 0.5 ? "mid" : "low";
  return <span className={`conf conf--${level}`}>AI {pct}%</span>;
}
