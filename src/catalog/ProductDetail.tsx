// Product detail & history (spec 3.8). Shows the current attributes, lets an
// owner/manager edit, toggle selling status, or archive (never hard-delete), and
// exposes a read-only history tab (price changes, audit before/after, inventory
// movements). Editing preserves old-bill snapshots — see server/f3/products.js.
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader, Button } from "../components/ui";
import { Sheet, InlineError } from "../sales/ui";
import { IconEdit, IconBox } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api, ApiError } from "../lib/api";
import type { ProductDetailResult } from "../lib/api";
import { formatVnd } from "../lib/format";
import { STATUS_LABEL, unitLabel } from "../lib/catalog";

function fmtDate(s: string): string {
  try { return new Date(s).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }); }
  catch { return s; }
}
function fmtQty(n: number | null | undefined): string {
  if (n == null) return "—";
  return Number.isInteger(n) ? String(n) : String(n).replace(/\.?0+$/, "");
}

const MOVE_LABEL: Record<string, string> = {
  opening: "Tồn đầu kỳ", sale: "Bán hàng", sale_return: "Trả hàng", purchase_receipt: "Nhập hàng",
  damage_writeoff: "Hủy/hỏng", manual_adjustment: "Điều chỉnh", count_adjustment: "Kiểm kê", reversal: "Đảo bút toán",
};
const AUDIT_LABEL: Record<string, string> = {
  "product.created": "Tạo sản phẩm", "product.updated": "Cập nhật", "product.status_changed": "Đổi trạng thái",
  "product.barcode_changed": "Đổi mã vạch", "product.quick_create": "Tạo nhanh", "product.ai_confirmed": "Duyệt gợi ý AI",
};

export function ProductDetail() {
  const nav = useNavigate();
  const { merchant, refresh } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const { id } = useParams();
  const [data, setData] = useState<ProductDetailResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"info" | "history">("info");
  const [menuOpen, setMenuOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!merchantId || !id) return;
    setLoading(true);
    try { setData(await api.getProduct(merchantId, id)); }
    catch { setError("Không tải được sản phẩm."); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [merchantId, id]);

  async function setStatus(action: "activate" | "deactivate" | "archive", reason?: string) {
    if (!data || !id || busy) return;
    setBusy(true); setError(null); setMenuOpen(false); setArchiveOpen(false);
    try {
      await api.setProductStatus(merchantId, id, action, data.product.rowVersion ?? 0, reason);
      await refresh();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không cập nhật được trạng thái.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="screen">
        <PageHeader title="Chi tiết" onBack={() => nav("/kho")} />
        <div className="muted" style={{ textAlign: "center", padding: 40 }}>Đang tải…</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="screen">
        <PageHeader title="Chi tiết" onBack={() => nav("/kho")} />
        <InlineError message={error ?? "Không tìm thấy sản phẩm."} />
      </div>
    );
  }

  const p = data.product;
  const timeline = [
    ...data.auditEvents.map((a) => ({ at: a.createdAt, kind: "audit" as const, a })),
    ...data.movements.map((m) => ({ at: m.createdAt, kind: "move" as const, m })),
  ].sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime());

  return (
    <div className="screen">
      <PageHeader
        title="Chi tiết"
        onBack={() => nav("/kho")}
        right={
          <div style={{ position: "relative" }}>
            <button className="step__back" onClick={() => setMenuOpen((v) => !v)} aria-label="Thêm">⋯</button>
            {menuOpen && (
              <div className="pos-menu" onMouseLeave={() => setMenuOpen(false)}>
                <button onClick={() => { setMenuOpen(false); nav(`/kho/${id}/sua`); }}>Sửa</button>
                {p.status !== "archived" && <button onClick={() => { setMenuOpen(false); setArchiveOpen(true); }}>Lưu trữ</button>}
              </div>
            )}
          </div>
        }
      />
      <div className="content--plain">
        {error && <InlineError message={error} onClose={() => setError(null)} />}

        <div className="card detail-head">
          <div className="detail-head__top">
            <div className="detail-head__name">{p.name}</div>
            <span className={`pill pill--${p.status ?? "active"}`}>{STATUS_LABEL[p.status ?? "active"]}</span>
          </div>
          <div className="detail-head__price">{formatVnd(p.salePrice)} <span className="muted tiny">/ {unitLabel(p.unitCode)}</span></div>
          <div className="muted tiny">{p.productType === "service" ? "Dịch vụ" : "Hàng hóa"}{p.categoryName ? ` · ${p.categoryName}` : ""}</div>
        </div>

        <div className="segment" style={{ margin: "12px 0" }}>
          <button className={`segment__btn ${tab === "info" ? "segment__btn--on" : ""}`} onClick={() => setTab("info")}>Thông tin</button>
          <button className={`segment__btn ${tab === "history" ? "segment__btn--on" : ""}`} onClick={() => setTab("history")}>Lịch sử</button>
        </div>

        {tab === "info" ? (
          <div className="stack">
            <div className="kv"><span>Loại</span><b>{p.productType === "service" ? "Dịch vụ" : "Hàng hóa"}</b></div>
            <div className="kv"><span>Đơn vị</span><b>{unitLabel(p.unitCode)}</b></div>
            <div className="kv"><span>SKU</span><b>{p.sku || "—"}</b></div>
            <div className="kv"><span>Mã vạch</span><b>{p.barcode || "—"}</b></div>
            <div className="kv"><span>Nhóm hàng</span><b>{p.categoryName || "—"}</b></div>
            <div className="kv"><span>Theo dõi tồn</span><b>{p.trackInventory ? "Có" : "Không"}</b></div>
            {p.trackInventory && <div className="kv"><span>Tồn hiện có</span><b>{fmtQty(p.onHand)}</b></div>}
            {p.trackInventory && <div className="kv"><span>Mức tồn thấp</span><b>{p.lowStockThreshold != null ? fmtQty(p.lowStockThreshold) : "—"}</b></div>}
            {p.trackInventory && <div className="kv"><span>Cho bán âm</span><b>{p.negativeStockPolicy === "allow_owner" ? "Có" : "Không"}</b></div>}
            <div className="kv"><span>Cho phép giảm giá</span><b>{p.allowDiscount ? "Có" : "Không"}</b></div>
          </div>
        ) : (
          <div className="stack">
            {data.priceHistory.length > 1 && (
              <div className="card card--flat">
                <div className="form-sect__t" style={{ marginBottom: 6 }}>Lịch sử giá</div>
                {data.priceHistory.map((h, i) => (
                  <div key={i} className="kv"><span>{fmtDate(h.effectiveFrom)}</span><b>{formatVnd(h.priceVnd)}</b></div>
                ))}
              </div>
            )}
            {timeline.length === 0 ? (
              <div className="empty"><div className="empty__ic"><IconBox size={26} /></div><div className="empty__t">Chưa có hoạt động</div><div className="empty__d">Thay đổi và biến động tồn sẽ hiện ở đây.</div></div>
            ) : (
              timeline.map((t, i) => (
                <div key={i} className="tl-row">
                  <div className="tl-row__dot" />
                  <div className="tl-row__body">
                    {t.kind === "audit" ? (
                      <>
                        <div className="tl-row__t">{AUDIT_LABEL[t.a.action] ?? t.a.action}</div>
                        {renderAuditDelta(t.a.action, t.a.before, t.a.after)}
                      </>
                    ) : (
                      <>
                        <div className="tl-row__t">{MOVE_LABEL[t.m.movementType] ?? t.m.movementType}</div>
                        <div className="muted tiny">{t.m.quantityDelta > 0 ? "+" : ""}{fmtQty(t.m.quantityDelta)} → tồn {fmtQty(t.m.balanceAfter)}</div>
                      </>
                    )}
                    <div className="muted tiny">{fmtDate(t.at)}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <div className="form-foot form-foot--split">
        <Button variant="outline" onClick={() => nav(`/kho/${id}/sua`)}><IconEdit size={16} /> Sửa</Button>
        {p.status === "active" ? (
          <Button variant="navy" loading={busy} onClick={() => setStatus("deactivate", "ngừng bán")}>Ngừng bán</Button>
        ) : p.status === "inactive" ? (
          <Button variant="primary" loading={busy} onClick={() => setStatus("activate")}>Bật bán lại</Button>
        ) : (
          <Button variant="navy" disabled>Đã lưu trữ</Button>
        )}
      </div>

      <Sheet open={archiveOpen} onClose={() => setArchiveOpen(false)} title="Lưu trữ sản phẩm?"
        footer={
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn--outline" onClick={() => setArchiveOpen(false)}>Hủy</button>
            <button className="btn btn--danger" onClick={() => setStatus("archive", "archive")}>Lưu trữ</button>
          </div>
        }>
        <div className="muted">Sản phẩm sẽ ẩn khỏi danh sách và không bán được nữa, nhưng lịch sử bill và tồn kho vẫn được giữ nguyên. Bạn không thể xóa hẳn sản phẩm đã phát sinh giao dịch.</div>
      </Sheet>
    </div>
  );
}

function renderAuditDelta(action: string, before: Record<string, unknown>, after: Record<string, unknown>) {
  if (action === "product.status_changed") {
    return <div className="muted tiny">{STATUS_LABEL[(before.status as keyof typeof STATUS_LABEL)] ?? String(before.status)} → {STATUS_LABEL[(after.status as keyof typeof STATUS_LABEL)] ?? String(after.status)}</div>;
  }
  const keys = Object.keys(after || {}).filter((k) => k !== "source");
  if (keys.length === 0) return null;
  return (
    <div className="muted tiny">
      {keys.slice(0, 4).map((k) => `${k}: ${fmtVal(before?.[k])} → ${fmtVal(after?.[k])}`).join(" · ")}
    </div>
  );
}
function fmtVal(v: unknown): string {
  if (v == null || v === "") return "—";
  if (typeof v === "boolean") return v ? "Có" : "Không";
  return String(v);
}
