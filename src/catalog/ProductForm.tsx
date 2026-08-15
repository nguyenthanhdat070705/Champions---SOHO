// Create / edit a product (spec 3.2–3.7). One scrollable form organised into the
// spec's sections: type, AI label-photo shortcut, basic info, price & codes, and
// (goods only) inventory. Create is idempotent (one Idempotency-Key per form
// session → PRD-04); edit uses row_version optimistic locking (PRD-12). AI only
// fills a review sheet — it never auto-saves and never sets tax/negative-stock.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PageHeader, Button, TextField, SelectField } from "../components/ui";
import { Sheet, InlineError } from "../sales/ui";
import { ScanSheet } from "../sales/sheets";
import { IconCamera, IconSparkle, IconCheck } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import type { Category, AiImageDraft } from "../lib/api";
import { formatVnd } from "../lib/format";
import {
  emptyDraft, validateDraft, isDraftValid, draftToCreateBody, UNIT_OPTIONS, unitLabel,
} from "../lib/catalog";
import type { ProductDraft, ProductType } from "../lib/catalog";
import { CategoryPickerSheet, ConfidenceBadge, fileToBase64 } from "./parts";

export function ProductForm() {
  const nav = useNavigate();
  const { merchant, refresh } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const { id: editId } = useParams();
  const [sp] = useSearchParams();
  const isEdit = Boolean(editId);

  const [draft, setDraft] = useState<ProductDraft>(() => emptyDraft((sp.get("type") as ProductType) || "goods"));
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(isEdit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ message: string; productId?: string } | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [catOpen, setCatOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [rowVersion, setRowVersion] = useState<number | null>(null);
  const [currentOnHand, setCurrentOnHand] = useState<number | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);

  // AI review state
  const [aiBusy, setAiBusy] = useState(false);
  const [aiDraft, setAiDraft] = useState<AiImageDraft | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const idemKey = useRef<string>(newIdempotencyKey());
  const draftId = useRef<string>(newIdempotencyKey());

  const errors = useMemo(() => validateDraft(draft), [draft]);
  const valid = isDraftValid(draft);

  function patch(p: Partial<ProductDraft>) { setDraft((d) => ({ ...d, ...p })); setDirty(true); }

  useEffect(() => {
    if (!merchantId) return;
    api.listCategories(merchantId).then((r) => setCategories(r.categories)).catch(() => {});
  }, [merchantId]);

  useEffect(() => {
    const bc = sp.get("barcode");
    if (bc && !isEdit) setDraft((d) => ({ ...d, barcode: bc }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isEdit || !merchantId || !editId) return;
    let active = true;
    setLoading(true);
    api.getProduct(merchantId, editId)
      .then((r) => {
        if (!active) return;
        const p = r.product;
        setDraft({
          name: p.name,
          productType: (p.productType as ProductType) ?? "goods",
          categoryId: p.categoryId,
          unitCode: p.unitCode,
          price: String(p.salePrice),
          sku: p.sku ?? "",
          barcode: p.barcode ?? "",
          trackInventory: p.trackInventory,
          openingQty: "",
          lowStockThreshold: p.productLowStockThreshold != null ? String(p.productLowStockThreshold) : "",
          allowDiscount: p.allowDiscount,
          negativeStockPolicy: (p.negativeStockPolicy as "block" | "allow_owner") ?? "block",
        });
        setRowVersion(p.rowVersion ?? null);
        setCurrentOnHand(p.onHand ?? null);
        setDirty(false);
      })
      .catch(() => { if (active) setError("Không tải được sản phẩm."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [isEdit, merchantId, editId]);

  const isGoods = draft.productType === "goods";

  function requestBack() {
    if (dirty) setLeaveOpen(true);
    else nav(-1);
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setAiBusy(true); setError(null);
    try {
      const { base64, mimeType } = await fileToBase64(file);
      const res = await api.aiPreviewImage(merchantId, draftId.current, base64, mimeType);
      setAiDraft(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Không đọc được ảnh, bạn có thể nhập tay.");
    } finally {
      setAiBusy(false);
    }
  }

  function applyAi(accepted: { displayName: boolean; unitCode: boolean; priceVnd: boolean; category: boolean }) {
    if (!aiDraft) return;
    const next: Partial<ProductDraft> = {};
    if (accepted.displayName && aiDraft.fields.displayName) next.name = aiDraft.fields.displayName;
    if (accepted.unitCode && aiDraft.fields.unitCode) next.unitCode = aiDraft.fields.unitCode;
    if (accepted.priceVnd && aiDraft.fields.priceVnd != null) next.price = String(aiDraft.fields.priceVnd);
    if (accepted.category && aiDraft.category.categoryId) next.categoryId = aiDraft.category.categoryId;
    patch(next);
    api.aiConfirm(merchantId, aiDraft.suggestionId, "accept", Object.keys(accepted).filter((k) => (accepted as Record<string, boolean>)[k])).catch(() => {});
    setAiDraft(null);
  }
  function rejectAi() {
    if (aiDraft) api.aiConfirm(merchantId, aiDraft.suggestionId, "reject").catch(() => {});
    setAiDraft(null);
  }

  async function submit() {
    if (!valid || busy) return;
    setBusy(true); setError(null); setConflict(null);
    try {
      if (isEdit && editId) {
        const body: Record<string, unknown> = {
          expectedVersion: rowVersion,
          name: draft.name.trim(),
          productType: draft.productType,
          categoryId: draft.categoryId,
          unitCode: draft.unitCode,
          salePrice: Number(draft.price || 0),
          sku: draft.sku.trim() || null,
          barcode: draft.barcode.trim() || null,
          allowDiscount: draft.allowDiscount,
          trackInventory: isGoods ? draft.trackInventory : false,
          lowStockThreshold: isGoods && draft.trackInventory && draft.lowStockThreshold !== "" ? Number(draft.lowStockThreshold) : null,
          negativeStockPolicy: draft.negativeStockPolicy,
        };
        const res = await api.updateProduct(merchantId, editId, body);
        await refresh();
        nav(`/kho/${res.product.id}`, { replace: true });
      } else {
        const res = await api.createProduct(merchantId, draftToCreateBody(draft, draftId.current), idemKey.current);
        setDirty(false);
        nav(`/kho/${res.product.id}`, { replace: true });
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "PRODUCT_SKU_CONFLICT" || err.code === "PRODUCT_BARCODE_CONFLICT") {
          const pid = (err.details as { existing_product_id?: string } | undefined)?.existing_product_id;
          setConflict({ message: err.message, productId: pid });
        } else if (err.code === "VERSION_CONFLICT") {
          setError("Sản phẩm vừa được người khác sửa. Vui lòng mở lại để xem bản mới nhất.");
        } else {
          setError(err.message);
        }
      } else {
        setError("Không lưu được. Vui lòng thử lại.");
      }
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="screen">
        <PageHeader title={isEdit ? "Sửa sản phẩm" : "Thêm mới"} onBack={() => nav(-1)} />
        <div className="muted" style={{ textAlign: "center", padding: 40 }}>Đang tải…</div>
      </div>
    );
  }

  const categoryName = draft.categoryId ? categories.find((c) => c.id === draft.categoryId)?.name ?? "Đã chọn" : "Không phân nhóm";

  return (
    <div className="screen">
      <PageHeader title={isEdit ? "Sửa sản phẩm" : draft.productType === "service" ? "Dịch vụ mới" : "Hàng hóa mới"} onBack={requestBack} />
      <div className="content--plain form-scroll">
        {error && <InlineError message={error} onClose={() => setError(null)} />}
        {conflict && (
          <div className="banner banner--warn" style={{ marginBottom: 12 }}>
            {conflict.message}
            {conflict.productId && (
              <button className="link-btn" onClick={() => nav(`/kho/${conflict.productId}`)}>Mở sản phẩm hiện có</button>
            )}
          </div>
        )}

        {/* Type */}
        <div className="form-sect">
          <div className="form-sect__t">Loại</div>
          <div className="segment">
            <button className={`segment__btn ${isGoods ? "segment__btn--on" : ""}`}
              onClick={() => { if (!isGoods) patch({ productType: "goods", trackInventory: true, unitCode: draft.unitCode || "item" }); }}>Hàng hóa</button>
            <button className={`segment__btn ${!isGoods ? "segment__btn--on" : ""}`}
              onClick={() => { if (isGoods) patch({ productType: "service", trackInventory: false, unitCode: draft.unitCode || "lan" }); }}>Dịch vụ</button>
          </div>
          {isEdit && !isGoods && currentOnHand != null && (
            <div className="field__hint" style={{ color: "#b45309" }}>Chuyển sang dịch vụ sẽ tắt theo dõi tồn (không xóa lịch sử tồn cũ).</div>
          )}
        </div>

        {/* AI shortcut (create + goods) */}
        {!isEdit && isGoods && (
          <div className="form-sect">
            <button className="ai-shortcut" onClick={() => fileRef.current?.click()} disabled={aiBusy}>
              {aiBusy ? <span className="spinner spinner--sm" /> : <IconSparkle size={18} />}
              <span>{aiBusy ? "Đang đọc nhãn…" : "Chụp nhãn để tự điền"}</span>
            </button>
            <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={onPickFile} />
            <div className="field__hint">AI chỉ gợi ý — bạn luôn kiểm tra và sửa trước khi lưu.</div>
          </div>
        )}

        {/* Basic info */}
        <div className="form-sect">
          <div className="form-sect__t">Thông tin cơ bản</div>
          <TextField label="Tên" value={draft.name} onChange={(v) => patch({ name: v })} placeholder="VD: Nước suối 500ml" required maxLength={120} error={dirty ? errors.name : undefined} />
          <div className="field">
            <label className="field__label">Nhóm hàng</label>
            <button className="input input--select" onClick={() => setCatOpen(true)}>{categoryName}</button>
          </div>
          {isGoods ? (
            <SelectField label="Đơn vị" value={draft.unitCode} onChange={(v) => patch({ unitCode: v })} required options={UNIT_OPTIONS} />
          ) : (
            <SelectField label="Đơn vị" value={draft.unitCode} onChange={(v) => patch({ unitCode: v })} options={UNIT_OPTIONS} />
          )}
        </div>

        {/* Price & codes */}
        <div className="form-sect">
          <div className="form-sect__t">Giá bán & mã nhận diện</div>
          <div className="field">
            <label className="field__label">Giá bán <span className="field__req">*</span></label>
            <input className={`input ${dirty && errors.price ? "input--error" : ""}`} value={draft.price}
              onChange={(e) => patch({ price: e.target.value.replace(/\D/g, "") })} inputMode="numeric" placeholder="10000" />
            {draft.price ? <div className="field__hint">{formatVnd(Number(draft.price))}</div> : dirty && errors.price ? <div className="field__error">{errors.price}</div> : null}
          </div>
          <TextField label="SKU (mã nội bộ)" value={draft.sku} onChange={(v) => patch({ sku: v.toUpperCase() })} placeholder="VD: NS500" optional />
          <div className="field">
            <label className="field__label">Mã vạch <span className="field__opt"> (không bắt buộc)</span></label>
            <div style={{ display: "flex", gap: 8 }}>
              <input className="input" value={draft.barcode} onChange={(e) => patch({ barcode: e.target.value })} inputMode="numeric" placeholder="Quét hoặc nhập" />
              <button className="btn btn--outline" style={{ width: "auto", padding: "0 14px" }} onClick={() => setScanOpen(true)} aria-label="Quét"><IconCamera size={18} /></button>
            </div>
          </div>
        </div>

        {/* Inventory (goods only) */}
        {isGoods && (
          <div className="form-sect">
            <div className="form-sect__t">Theo dõi tồn kho</div>
            <div className="switch-row" onClick={() => patch({ trackInventory: !draft.trackInventory })}>
              <div>
                <div className="switch-row__t">Theo dõi tồn</div>
                <div className="switch-row__d">Bật để trừ tồn khi bán</div>
              </div>
              <span className={`switch ${draft.trackInventory ? "switch--on" : ""}`}><span className="switch__dot" /></span>
            </div>
            {draft.trackInventory && (
              <>
                {isEdit ? (
                  <div className="field__hint">Tồn hiện có: <b>{currentOnHand ?? 0}</b>. Thay đổi tồn qua nhập hàng/kiểm kho, không sửa trực tiếp tại đây.</div>
                ) : (
                  <TextField label="Tồn hiện có" value={draft.openingQty} onChange={(v) => patch({ openingQty: v.replace(/[^\d.]/g, "") })} inputMode="numeric" placeholder="0" optional />
                )}
                <TextField label="Mức tồn thấp" value={draft.lowStockThreshold} onChange={(v) => patch({ lowStockThreshold: v.replace(/[^\d.]/g, "") })} inputMode="numeric" placeholder="0" optional />
                <button className="link-btn" onClick={() => setAdvanced((v) => !v)} style={{ marginTop: 4 }}>{advanced ? "Ẩn nâng cao" : "Nâng cao"}</button>
                {advanced && (
                  <div className="switch-row" onClick={() => patch({ negativeStockPolicy: draft.negativeStockPolicy === "allow_owner" ? "block" : "allow_owner" })}>
                    <div>
                      <div className="switch-row__t">Cho bán âm</div>
                      <div className="switch-row__d">Chỉ chủ cửa hàng. Mặc định tắt.</div>
                    </div>
                    <span className={`switch ${draft.negativeStockPolicy === "allow_owner" ? "switch--on" : ""}`}><span className="switch__dot" /></span>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Discount */}
        <div className="form-sect">
          <div className="switch-row" onClick={() => patch({ allowDiscount: !draft.allowDiscount })}>
            <div>
              <div className="switch-row__t">Cho phép giảm giá</div>
              <div className="switch-row__d">Thu ngân có thể giảm giá dòng này khi bán</div>
            </div>
            <span className={`switch ${draft.allowDiscount ? "switch--on" : ""}`}><span className="switch__dot" /></span>
          </div>
        </div>
      </div>

      <div className="form-foot">
        <Button variant="primary" loading={busy} disabled={!valid} disabledReason={!valid ? "Nhập tên và giá hợp lệ để tiếp tục" : undefined} onClick={submit}>
          {isEdit ? "Lưu thay đổi" : "Tạo sản phẩm"}
        </Button>
      </div>

      <CategoryPickerSheet
        open={catOpen} merchantId={merchantId} categories={categories} value={draft.categoryId}
        onClose={() => setCatOpen(false)}
        onSelect={(cid) => patch({ categoryId: cid })}
        onCreated={(c) => setCategories((cs) => [...cs, c])}
      />

      <ScanSheet
        open={scanOpen} merchantId={merchantId}
        onClose={() => setScanOpen(false)}
        onFound={(p) => { setScanOpen(false); if (p.id === editId) return; setConflict({ message: `Mã vạch đã thuộc sản phẩm “${p.name}”.`, productId: p.id }); }}
        onNotFound={(code) => { setScanOpen(false); patch({ barcode: code }); }}
      />

      {aiDraft && <AiReviewSheet draft={aiDraft} onApply={applyAi} onReject={rejectAi} />}

      <Sheet open={leaveOpen} onClose={() => setLeaveOpen(false)} title="Bỏ thay đổi?"
        footer={
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn--outline" onClick={() => setLeaveOpen(false)}>Ở lại</button>
            <button className="btn btn--danger" onClick={() => { setLeaveOpen(false); nav(-1); }}>Bỏ thay đổi</button>
          </div>
        }>
        <div className="muted">Bạn có thay đổi chưa lưu. Thoát sẽ mất những gì vừa nhập.</div>
      </Sheet>
    </div>
  );
}

// ── AI review sheet (spec 3.6) ────────────────────────────────────────────────
function AiReviewSheet({
  draft, onApply, onReject,
}: {
  draft: AiImageDraft;
  onApply: (a: { displayName: boolean; unitCode: boolean; priceVnd: boolean; category: boolean }) => void;
  onReject: () => void;
}) {
  const f = draft.fields;
  const [accepted, setAccepted] = useState({
    displayName: Boolean(f.displayName),
    unitCode: Boolean(f.unitCode),
    priceVnd: f.priceVnd != null,
    category: Boolean(draft.category.categoryId) && draft.category.preselect,
  });
  const toggle = (k: keyof typeof accepted) => setAccepted((a) => ({ ...a, [k]: !a[k] }));
  const Row = ({ k, label, value, conf }: { k: keyof typeof accepted; label: string; value: string; conf?: number | null }) => (
    <button className={`ai-row ${accepted[k] ? "ai-row--on" : ""}`} onClick={() => toggle(k)} disabled={value === "—"}>
      <div className="ai-row__box">{accepted[k] && <IconCheck size={14} color="#fff" />}</div>
      <div className="ai-row__body">
        <div className="ai-row__label">{label} <ConfidenceBadge value={conf} /></div>
        <div className="ai-row__value">{value}</div>
      </div>
    </button>
  );

  return (
    <Sheet open onClose={onReject} title="AI xem lại"
      footer={
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn btn--outline" onClick={onReject}>Nhập lại</button>
          <button className="btn btn--primary" onClick={() => onApply(accepted)}>Dùng gợi ý</button>
        </div>
      }>
      <div className="muted tiny" style={{ marginBottom: 10 }}>Các trường do AI suy đoán. Chạm để chọn/bỏ trước khi dùng.</div>
      <div className="stack">
        <Row k="displayName" label="Tên" value={f.displayName ?? "—"} conf={draft.fieldConfidence.displayName} />
        <Row k="unitCode" label="Đơn vị" value={f.unitCode ? unitLabel(f.unitCode) : "—"} conf={draft.fieldConfidence.unitCode} />
        <Row k="priceVnd" label="Giá bán" value={f.priceVnd != null ? formatVnd(f.priceVnd) : "—"} conf={draft.fieldConfidence.priceVnd} />
        {draft.category.suggestedName && (
          <Row k="category" label="Nhóm hàng" value={draft.category.suggestedName} conf={draft.category.confidence} />
        )}
      </div>
      {draft.warnings.length > 0 && (
        <div className="banner banner--warn" style={{ marginTop: 12 }}>{draft.warnings.join(" ")}</div>
      )}
    </Sheet>
  );
}
