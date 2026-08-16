// "Chi tiết & đảo phiếu" (spec 3.8). A posted receipt is IMMUTABLE — this is the
// read-only record: supplier/date/total, the lines, the stock movements it created
// (deep-link to each product's ledger), the pending accounting draft, and the
// document. Owner/manager can REVERSE a posted receipt (appends opposite movements,
// blocked if goods were already sold — spec 4.2). Reversed/cancelled are view-only.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader, Button, Banner } from "../components/ui";
import { Sheet, InlineError } from "../sales/ui";
import { IconCamera, IconChevron, IconTruck } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import type { ReceiptDetail as ReceiptDetailData } from "../lib/api";
import { formatVnd } from "../lib/format";
import { unitLabel } from "../lib/catalog";
import { fmtQty } from "../lib/receiving";
import { RECEIPT_STATUS_LABEL, receiptStatusClass } from "../lib/receiving";
import type { ReceiptStatus } from "../lib/receiving";

function fmtDate(s: string): string {
  try { return new Date(`${s}T00:00:00`).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }); }
  catch { return s; }
}

const ACC_STATUS_LABEL: Record<string, string> = { pending: "Chờ kiểm tra", reviewed: "Đã kiểm tra", rejected: "Đã từ chối" };

export function ReceiptDetail({ data, reload }: { data: ReceiptDetailData; reload: () => void }) {
  const nav = useNavigate();
  const { merchant, role } = useMerchant();
  const mid = merchant?.id ?? "";
  const canManage = role === "owner" || role === "manager";
  const { receipt, items, accounting, movements } = data;
  const status = receipt.status as ReceiptStatus;

  const [reverseOpen, setReverseOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function viewDocument() {
    if (!receipt.documentId) return;
    try {
      const r = await api.documentUrl(mid, receipt.documentId);
      window.open(r.url, "_blank", "noopener");
    } catch { setError("Không mở được ảnh chứng từ."); }
  }

  async function doReverse() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await api.reverseReceipt(mid, receipt.id, {}, newIdempotencyKey());
      setReverseOpen(false);
      reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === "RECEIPT_REVERSE_NEGATIVE") {
        setError("Không thể đảo phiếu: hàng đã được bán hoặc dùng bớt. Hãy điều chỉnh tồn thủ công nếu cần.");
        setReverseOpen(false);
      } else {
        setError(e instanceof ApiError ? e.message : "Không đảo được phiếu.");
      }
    } finally { setBusy(false); }
  }

  return (
    <div className="screen">
      <PageHeader title="Chi tiết phiếu nhập" onBack={() => nav("/nhap-hang")} />
      <div className="content--plain form-scroll">
        {error && <InlineError message={error} onClose={() => setError(null)} />}

        <div className="card detail-head">
          <div className="detail-head__top">
            <div className="detail-head__name">{receipt.supplierName || "Không ghi NCC"}</div>
            <span className={`pill ${receiptStatusClass(status)}`}>{RECEIPT_STATUS_LABEL[status]}</span>
          </div>
          <div className="muted tiny">{receipt.receiptNumber} · {fmtDate(receipt.receivedAt)}</div>
          <div className="rcpt-total"><span>Tổng tiền phiếu</span><b>{formatVnd(receipt.grandTotalVnd)}</b></div>
          {receipt.extraCostVnd > 0 && <div className="muted tiny">Gồm chi phí phụ {formatVnd(receipt.extraCostVnd)}</div>}
        </div>

        {status === "reversed" && <Banner kind="warn">Phiếu này đã được đảo — các bút toán tồn đã được hoàn ngược.</Banner>}
        {status === "cancelled" && <Banner kind="warn">Phiếu này đã hủy trước khi ghi nhận. Không ảnh hưởng tồn kho.</Banner>}

        <div className="form-sect__t" style={{ margin: "14px 2px 6px" }}>Dòng hàng ({items.length})</div>
        <div className="stack">
          {items.map((it) => (
            <div key={it.id} className="card card--flat rcpt-line">
              <div className="rcpt-line__main">
                <div className="inv-row__name">{it.name}</div>
                <div className="muted tiny">{fmtQty(it.quantity)} {unitLabel(it.unitCode)} × {formatVnd(it.unitCostVnd)}</div>
              </div>
              <div className="rcpt-line__total">{formatVnd(it.lineTotalVnd)}</div>
            </div>
          ))}
        </div>

        {receipt.documentId && (
          <div style={{ marginTop: 14 }}>
            <button className="btn btn--outline" onClick={viewDocument}><IconCamera size={16} /> Xem ảnh chứng từ</button>
          </div>
        )}

        {accounting && accounting.length > 0 && (
          <>
            <div className="form-sect__t" style={{ margin: "16px 2px 6px" }}>Dữ liệu chi phí / kế toán</div>
            <div className="stack">
              {accounting.map((a) => (
                <div key={a.id} className="card card--flat kv">
                  <span>{a.eventType === "reversed" ? "Đảo chi phí" : "Chi phí mua hàng"}</span>
                  <b>{formatVnd(a.amountVnd)} · {ACC_STATUS_LABEL[a.reviewStatus] ?? a.reviewStatus}</b>
                </div>
              ))}
            </div>
            <div className="field__hint">Dữ liệu này sẵn để functional chi phí xử lý — chưa phải là đã thanh toán.</div>
          </>
        )}

        {movements && movements.length > 0 && (
          <>
            <div className="form-sect__t" style={{ margin: "16px 2px 6px" }}>Bút toán tồn kho</div>
            <div className="stack">
              {movements.map((m) => (
                <button key={m.id} className="card card--flat mv-row" onClick={() => nav(`/ton-kho/${m.productId}`)}>
                  <div className={`mv-row__delta ${m.quantityDelta >= 0 ? "mv-row__delta--up" : "mv-row__delta--down"}`}>{m.quantityDelta >= 0 ? "+" : ""}{fmtQty(m.quantityDelta)}</div>
                  <div className="mv-row__body">
                    <div className="mv-row__top"><span className="mv-row__type">{m.productName}</span><span className="muted tiny">tồn {fmtQty(m.balanceAfter)}</span></div>
                    <div className="mv-row__acts"><span className="mv-row__link">Xem sổ tồn <IconChevron size={13} /></span></div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {canManage && status === "posted" && (
        <div className="form-foot">
          <Button variant="danger" onClick={() => setReverseOpen(true)}>Đảo phiếu</Button>
        </div>
      )}
      {status === "reversed" && (
        <div className="form-foot">
          <Button variant="outline" onClick={() => nav("/nhap-hang")}><IconTruck size={15} /> Về danh sách</Button>
        </div>
      )}

      <Sheet open={reverseOpen} onClose={() => setReverseOpen(false)} title="Đảo phiếu nhập này?"
        footer={
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn--outline" onClick={() => setReverseOpen(false)} style={{ flex: 1 }}>Hủy</button>
            <div style={{ flex: 1 }}><Button variant="danger" loading={busy} onClick={doReverse}>Đảo phiếu</Button></div>
          </div>
        }>
        <div className="muted">
          Tạo bút toán ngược để hoàn lại {items.length} dòng đã nhập. Phiếu gốc được giữ nguyên để truy vết.
          Nếu hàng đã bán bớt khiến tồn xuống dưới 0, hệ thống sẽ chặn để không tạo tồn âm.
        </div>
      </Sheet>
    </div>
  );
}
