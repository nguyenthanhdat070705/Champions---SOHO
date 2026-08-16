// "Phiếu nhập" editor (spec 3.3–3.7). One screen that builds a draft — header
// (ngày, nhà cung cấp, chứng từ), dòng hàng, tổng tiền — then a confirm step that
// shows the stock impact + the pending accounting draft BEFORE committing (spec
// 3.7). "Hàng đã về" posts atomically; nothing changes stock until then. AI/OCR
// only fills a review sheet the user must resolve (spec 3.6). Owner/manager only.
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { PageHeader, Button, Banner } from "../components/ui";
import { InlineError } from "../sales/ui";
import { useMerchant } from "../dashboard/MerchantContext";
import { IconCamera, IconPlus, IconTrash, IconTruck } from "../components/icons";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import type { Receipt, ReceiptItem, ReceiptPreview, ApiProduct, DocumentExtraction } from "../lib/api";
import { formatVnd } from "../lib/format";
import { unitLabel } from "../lib/catalog";
import { fmtQty, computeTotals, parseQty, parseCost, lineTotal } from "../lib/receiving";
import { SupplierPickerSheet, ProductPickerSheet, LineEditSheet, ExtractionReviewSheet } from "./parts";
import type { DraftLine } from "./parts";

function itemToDraft(it: ReceiptItem): DraftLine {
  return { productId: it.productId, name: it.name, unitCode: it.unitCode, quantity: String(it.quantity), unitCost: String(it.unitCostVnd), matchSource: it.matchSource, matchConfidence: it.matchConfidence };
}

export function ReceiptEditor({ receipt, items, onPosted, reload }: {
  receipt: Receipt; items: ReceiptItem[]; onPosted: () => void; reload: () => void;
}) {
  const nav = useNavigate();
  const location = useLocation();
  const { merchant } = useMerchant();
  const mid = merchant?.id ?? "";

  const [receivedAt, setReceivedAt] = useState(receipt.receivedAt);
  const [supplier, setSupplier] = useState<{ id: string | null; name: string | null }>({ id: receipt.supplierId, name: receipt.supplierName });
  const [lines, setLines] = useState<DraftLine[]>(items.map(itemToDraft));
  const [documentId] = useState<string | null>(receipt.documentId);

  const [supplierOpen, setSupplierOpen] = useState(false);
  const [productOpen, setProductOpen] = useState(false);
  const [editLineIdx, setEditLineIdx] = useState<number | null>(null);
  const [pendingProduct, setPendingProduct] = useState<ApiProduct | null>(null);
  const [reviewExtraction, setReviewExtraction] = useState<DocumentExtraction | null>(null);

  const [step, setStep] = useState<"edit" | "confirm">("edit");
  const [preview, setPreview] = useState<ReceiptPreview | null>(null);
  const [postKey, setPostKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowVersion, setRowVersion] = useState(receipt.rowVersion);

  // If arriving from a photo capture, open the AI review sheet once.
  useEffect(() => {
    const ex = (location.state as { extraction?: DocumentExtraction } | null)?.extraction;
    if (ex && ex.status !== "failed" && ex.lines?.length) setReviewExtraction(ex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totals = useMemo(() => computeTotals(
    lines.map((l) => ({ quantity: parseQty(l.quantity) ?? 0, unitCostVnd: parseCost(l.unitCost) ?? 0 })),
    receipt.extraCostVnd,
  ), [lines, receipt.extraCostVnd]);

  const validLines = lines.filter((l) => parseQty(l.quantity) != null && parseCost(l.unitCost) != null);
  const canContinue = validLines.length > 0;

  function addProduct(p: ApiProduct) {
    setProductOpen(false);
    setPendingProduct(p);
  }
  function saveNewLine(l: DraftLine) {
    setLines((ls) => [...ls, l]);
    setPendingProduct(null);
  }
  function saveEditedLine(l: DraftLine) {
    setLines((ls) => ls.map((x, i) => (i === editLineIdx ? l : x)));
    setEditLineIdx(null);
  }
  function removeLine(idx: number) {
    setLines((ls) => ls.filter((_, i) => i !== idx));
    setEditLineIdx(null);
  }
  function useExtracted(newLines: DraftLine[]) {
    setReviewExtraction(null);
    setLines((ls) => {
      const have = new Set(ls.map((l) => l.productId));
      const merged = [...ls];
      for (const nl of newLines) if (!have.has(nl.productId)) merged.push(nl);
      return merged;
    });
  }

  /** Persist header + lines to the server (draft autosave / before preview). */
  async function persist(): Promise<boolean> {
    try {
      await api.updateReceipt(mid, receipt.id, {
        receivedAt, supplierId: supplier.id, supplierName: supplier.id ? undefined : supplier.name, expectedVersion: rowVersion,
      });
      const r = await api.putReceiptItems(mid, receipt.id, {
        items: validLines.map((l) => ({ productId: l.productId, quantity: parseQty(l.quantity) as number, unitCostVnd: parseCost(l.unitCost) as number, matchSource: l.matchSource, matchConfidence: l.matchConfidence })),
      });
      setRowVersion(r.receipt.rowVersion);
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không lưu được phiếu.");
      return false;
    }
  }

  async function saveDraft() {
    if (busy) return;
    setBusy(true); setError(null);
    const okSave = await persist();
    setBusy(false);
    if (okSave) nav("/nhap-hang");
  }

  async function goConfirm() {
    if (!canContinue || busy) return;
    setBusy(true); setError(null);
    if (!(await persist())) { setBusy(false); return; }
    try {
      const pv = await api.previewReceipt(mid, receipt.id);
      setPreview(pv);
      setRowVersion(pv.receipt.rowVersion);
      setPostKey(newIdempotencyKey());
      setStep("confirm");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không xem trước được.");
    } finally { setBusy(false); }
  }

  async function doPost() {
    if (!preview || busy) return;
    setBusy(true); setError(null);
    try {
      await api.postReceipt(mid, receipt.id, { expectedReceiptVersion: rowVersion }, postKey);
      onPosted();
    } catch (e) {
      if (e instanceof ApiError && (e.code === "VERSION_CONFLICT" || e.code === "INVENTORY_BALANCE_CHANGED")) {
        setError("Phiếu hoặc tồn kho vừa thay đổi. Vui lòng kiểm tra lại.");
        setStep("edit"); reload();
      } else {
        setError(e instanceof ApiError ? e.message : "Không ghi nhận được. Vui lòng thử lại.");
      }
    } finally { setBusy(false); }
  }

  async function viewDocument() {
    if (!documentId) return;
    try {
      const r = await api.documentUrl(mid, documentId);
      window.open(r.url, "_blank", "noopener");
    } catch { setError("Không mở được ảnh chứng từ."); }
  }

  // ── Confirm step (spec 3.7) ─────────────────────────────────────────────────
  if (step === "confirm" && preview) {
    return (
      <div className="screen">
        <PageHeader title="Xác nhận hàng đã về" onBack={() => setStep("edit")} />
        <div className="content--plain form-scroll">
          {error && <InlineError message={error} onClose={() => setError(null)} />}
          <div className="card detail-head">
            <div className="detail-head__top"><div className="detail-head__name">{supplier.name || "Không ghi NCC"}</div></div>
            <div className="muted tiny">{receipt.receiptNumber} · {receivedAt} · {preview.lines.length} mặt hàng</div>
            <div className="rcpt-total"><span>Tổng tiền phiếu</span><b>{formatVnd(preview.totals.grandTotalVnd)}</b></div>
          </div>

          <div className="form-sect__t" style={{ margin: "14px 2px 6px" }}>Tác động tồn kho</div>
          <div className="stack">
            {preview.lines.map((l) => (
              <div key={l.productId} className="card card--flat rcpt-impact">
                <div className="rcpt-impact__main">
                  <div className="inv-row__name">{l.name}</div>
                  <div className="muted tiny">{fmtQty(l.quantity)} {unitLabel(l.unitCode)} × {formatVnd(l.unitCostVnd)} = {formatVnd(l.lineTotalVnd)}</div>
                </div>
                <div className="rcpt-impact__ba">
                  <span className="muted tiny">{fmtQty(l.before)}</span>
                  <span className="rcpt-impact__arrow">▲ {fmtQty(l.delta)}</span>
                  <span className="rcpt-impact__after">{fmtQty(l.after)}</span>
                </div>
              </div>
            ))}
          </div>

          <Banner kind="info">
            Sẽ tạo một dữ liệu chi phí mua hàng <b>{formatVnd(preview.accountingPreview.amountVnd)}</b> ở trạng thái “Chờ kiểm tra”.
            Đây chưa phải là đã thanh toán.
          </Banner>
        </div>

        <div className="form-foot form-foot--split">
          <Button variant="outline" onClick={() => setStep("edit")}>Sửa</Button>
          <Button variant="primary" loading={busy} onClick={doPost}><IconTruck size={16} /> Hàng đã về</Button>
        </div>
      </div>
    );
  }

  // ── Edit step ───────────────────────────────────────────────────────────────
  return (
    <div className="screen">
      <PageHeader title="Phiếu nhập" onBack={() => nav("/nhap-hang")} />
      <div className="content--plain form-scroll rcpt-scroll">
        {error && <InlineError message={error} onClose={() => setError(null)} />}

        <div className="form-sect">
          <div className="form-sect__t">Thông tin phiếu</div>
          <div className="field">
            <label className="field__label">Ngày nhận <span className="field__req">*</span></label>
            <input className="input" type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} max={new Date(Date.now() + 864e5).toISOString().slice(0, 10)} />
          </div>
          <div className="field">
            <label className="field__label">Nhà cung cấp <span className="field__opt">(không bắt buộc)</span></label>
            <button className="input input--select" onClick={() => setSupplierOpen(true)}>{supplier.name || "Chọn hoặc nhập tên"}</button>
          </div>
          <div className="field">
            <label className="field__label">Chứng từ</label>
            {documentId ? (
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn--outline" onClick={viewDocument} style={{ flex: 1 }}><IconCamera size={16} /> Xem ảnh chứng từ</button>
              </div>
            ) : (
              <div className="field__hint">Chưa đính ảnh. Bạn có thể tạo phiếu từ ảnh ở màn hình danh sách.</div>
            )}
          </div>
        </div>

        <div className="form-sect">
          <div className="form-sect__t" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Dòng hàng</span>
            <button className="link-btn" onClick={() => setProductOpen(true)}><IconPlus size={14} /> Thêm hàng</button>
          </div>
          {lines.length === 0 ? (
            <div className="empty" style={{ padding: 20 }}>
              <div className="empty__ic"><IconTruck size={24} /></div>
              <div className="empty__t">Chưa có dòng hàng</div>
              <div className="empty__d">Bấm “Thêm hàng” để chọn sản phẩm, nhập số lượng và đơn giá.</div>
            </div>
          ) : (
            <div className="stack">
              {lines.map((l, i) => {
                const q = parseQty(l.quantity), c = parseCost(l.unitCost);
                const bad = q == null || c == null;
                return (
                  <div key={i} className={`card card--flat rcpt-line ${bad ? "rcpt-line--warn" : ""}`} onClick={() => setEditLineIdx(i)}>
                    <div className="rcpt-line__main">
                      <div className="inv-row__name">{l.name}</div>
                      <div className="muted tiny">
                        {bad ? "Cần nhập số lượng & đơn giá" : `${fmtQty(q)} ${unitLabel(l.unitCode)} × ${formatVnd(c as number)}`}
                        {l.matchSource === "ai" ? " · từ AI" : ""}
                      </div>
                    </div>
                    <div className="rcpt-line__total">{bad ? "—" : formatVnd(lineTotal(q as number, c as number))}</div>
                    <button className="rcpt-line__del" onClick={(e) => { e.stopPropagation(); removeLine(i); }} aria-label="Xóa"><IconTrash size={16} /></button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Sticky totals + CTA */}
      <div className="rcpt-foot">
        <div className="rcpt-foot__totals">
          <div className="rcpt-foot__row"><span>Tạm tính</span><b>{formatVnd(totals.subtotalVnd)}</b></div>
          <div className="rcpt-foot__row rcpt-foot__row--grand"><span>Tổng phiếu</span><b>{formatVnd(totals.grandTotalVnd)}</b></div>
        </div>
        <div className="form-foot form-foot--split" style={{ position: "static", boxShadow: "none", padding: 0 }}>
          <Button variant="outline" loading={busy} onClick={saveDraft}>Lưu nháp</Button>
          <Button variant="primary" loading={busy} disabled={!canContinue} disabledReason={!canContinue ? "Thêm ít nhất một dòng hợp lệ." : undefined} onClick={goConfirm}>Xem lại</Button>
        </div>
      </div>

      <SupplierPickerSheet open={supplierOpen} merchantId={mid} value={supplier.id} onClose={() => setSupplierOpen(false)} onPick={setSupplier} />
      <ProductPickerSheet open={productOpen} merchantId={mid} excludeIds={lines.map((l) => l.productId)} onClose={() => setProductOpen(false)} onPick={addProduct} />
      <LineEditSheet open={Boolean(pendingProduct)} line={pendingProduct ? { productId: pendingProduct.id, name: pendingProduct.name, unitCode: pendingProduct.unitCode, quantity: "", unitCost: "" } : null}
        onClose={() => setPendingProduct(null)} onSave={saveNewLine} />
      <LineEditSheet open={editLineIdx != null} line={editLineIdx != null ? lines[editLineIdx] : null}
        onClose={() => setEditLineIdx(null)} onSave={saveEditedLine} onRemove={editLineIdx != null ? () => removeLine(editLineIdx) : undefined} />
      <ExtractionReviewSheet open={Boolean(reviewExtraction)} merchantId={mid} extraction={reviewExtraction} onClose={() => setReviewExtraction(null)} onUse={useExtracted} />
    </div>
  );
}
