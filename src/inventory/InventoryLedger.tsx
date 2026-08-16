// "Chi tiết tồn" — explain the number (spec 3.2). Big on-hand + available (when a
// QR/order is holding stock), then the movement timeline: each row shows the ±
// change, the resulting balance, a deep-link to its source (bill / return / count),
// the everyday reason and the actor. Owner/manager can quick-adjust, count just this
// item, or REVERSE a manual/count movement (never edits the original row). A ledger-
// vs-balance mismatch shows a warning banner but is never auto-fixed (spec 7).
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader, Button, Banner } from "../components/ui";
import { Sheet, InlineError } from "../sales/ui";
import { IconBox, IconEdit, IconClock, IconChevron } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import type { LedgerResult, MovementEntry } from "../lib/api";
import { unitLabel } from "../lib/catalog";
import { movementLabel, fmtQty, fmtDelta, REASON_LABEL } from "../lib/inventory";
import { StateBadge, AdjustSheet } from "./parts";

function fmtDate(s: string): string {
  try { return new Date(s).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }); }
  catch { return s; }
}

export function InventoryLedger() {
  const nav = useNavigate();
  const { merchant, role } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const canManage = role === "owner" || role === "manager";
  const { productId } = useParams();

  const [data, setData] = useState<LedgerResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<MovementEntry | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    if (!merchantId || !productId) return;
    setLoading(true);
    api.inventoryLedger(merchantId, productId, { limit: 100 })
      .then(setData)
      .catch(() => setError("Không tải được sổ tồn kho."))
      .finally(() => setLoading(false));
  }
  useEffect(load, [merchantId, productId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function startItemCount() {
    if (!merchantId || !productId || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await api.countCreate(merchantId, { name: `Kiểm kho ${data?.product.name ?? ""}`.trim(), blindCount: false, scope: { type: "products", productIds: [productId] } }, newIdempotencyKey());
      nav(`/ton-kho/kiem-kho/${r.session.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tạo được phiên kiểm kho.");
      setBusy(false);
    }
  }

  async function doReverse() {
    if (!merchantId || !reverseTarget || busy) return;
    setBusy(true); setError(null);
    try {
      await api.reverseMovement(merchantId, reverseTarget.id, { reasonCode: "CORRECTION" }, newIdempotencyKey());
      setReverseTarget(null);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không đảo được bút toán.");
    } finally { setBusy(false); }
  }

  if (loading) {
    return <div className="screen"><PageHeader title="Chi tiết tồn" onBack={() => nav("/ton-kho")} /><div className="muted" style={{ textAlign: "center", padding: 40 }}>Đang tải…</div></div>;
  }
  if (!data) {
    return <div className="screen"><PageHeader title="Chi tiết tồn" onBack={() => nav("/ton-kho")} /><InlineError message={error ?? "Không tìm thấy."} /></div>;
  }

  const p = data.product;
  const unit = unitLabel(p.unitCode);

  return (
    <div className="screen">
      <PageHeader title="Chi tiết tồn" onBack={() => nav("/ton-kho")} />
      <div className="content--plain">
        {error && <InlineError message={error} onClose={() => setError(null)} />}

        <div className="card detail-head">
          <div className="detail-head__top">
            <div className="detail-head__name">{p.name}</div>
            <StateBadge state={p.state} />
          </div>
          <div className="inv-big">
            <div className="inv-big__main"><div className="inv-big__num">{fmtQty(p.onHand)}</div><div className="muted tiny">Tồn hiện có ({unit})</div></div>
            {p.reserved > 0 && (
              <div className="inv-big__aside">
                <div className="inv-big__sub">{fmtQty(p.available)}</div>
                <div className="muted tiny">Khả dụng · đang giữ {fmtQty(p.reserved)}</div>
              </div>
            )}
          </div>
          {p.lowStockThreshold > 0 && <div className="muted tiny">Mức tồn thấp: {fmtQty(p.lowStockThreshold)} {unit}</div>}
        </div>

        {data.reconciliation.mismatch && (
          <Banner kind="warn">
            Sổ tồn lệch: hệ thống đang ghi {fmtQty(data.reconciliation.balanceQty)} nhưng tổng bút toán là {fmtQty(data.reconciliation.ledgerQty)}. Cần đối chiếu, hệ thống không tự sửa.
          </Banner>
        )}

        <div className="form-sect__t" style={{ margin: "14px 2px 6px" }}>Lịch sử biến động</div>
        {data.movements.length === 0 ? (
          <div className="empty"><div className="empty__ic"><IconBox size={26} /></div><div className="empty__t">Chưa có biến động</div><div className="empty__d">Bán hàng, nhập, trả, điều chỉnh và kiểm kê sẽ hiện ở đây.</div></div>
        ) : (
          <div className="stack">
            {data.movements.map((m) => {
              const canReverse = canManage && (m.movementType === "manual_adjustment" || m.movementType === "count_adjustment") && !m.reversed && m.originalMovementId == null;
              return (
                <div key={m.id} className="card card--flat mv-row">
                  <div className={`mv-row__delta ${m.quantityDelta >= 0 ? "mv-row__delta--up" : "mv-row__delta--down"}`}>{fmtDelta(m.quantityDelta)}</div>
                  <div className="mv-row__body">
                    <div className="mv-row__top">
                      <span className="mv-row__type">{movementLabel(m.movementType)}{m.reversed ? " · đã đảo" : ""}</span>
                      <span className="muted tiny">tồn {fmtQty(m.balanceAfter)}</span>
                    </div>
                    <div className="muted tiny">
                      {fmtDate(m.createdAt)}{m.actorName ? ` · ${m.actorName}` : ""}
                      {m.reasonCode && m.reasonCode !== "MISSING" ? ` · ${REASON_LABEL[m.reasonCode] ?? m.reasonCode}` : ""}
                    </div>
                    {m.note && <div className="muted tiny">“{m.note}”</div>}
                    <div className="mv-row__acts">
                      {m.source?.route && (
                        <button className="mv-row__link" onClick={() => nav(m.source!.route!)}>
                          {m.source.kind === "order" ? "Xem bill" : m.source.kind === "return" ? "Xem phiếu trả" : m.source.kind === "count" ? "Xem phiên kiểm" : m.source.kind === "receipt" ? "Xem phiếu nhập" : "Xem nguồn"}
                          {m.source.label ? ` ${m.source.label}` : ""} <IconChevron size={13} />
                        </button>
                      )}
                      {canReverse && <button className="mv-row__link mv-row__link--danger" onClick={() => setReverseTarget(m)}>Đảo bút toán</button>}
                    </div>
                  </div>
                </div>
              );
            })}
            {data.hasMore && <div className="muted tiny" style={{ textAlign: "center", padding: 8 }}>Chỉ hiển thị 100 biến động gần nhất.</div>}
          </div>
        )}
      </div>

      {canManage && (
        <div className="form-foot form-foot--split">
          <Button variant="outline" loading={busy} onClick={startItemCount}><IconClock size={15} /> Kiểm kho</Button>
          <Button variant="primary" onClick={() => setAdjustOpen(true)}><IconEdit size={15} /> Điều chỉnh</Button>
        </div>
      )}

      <AdjustSheet open={adjustOpen} onClose={() => setAdjustOpen(false)} merchantId={merchantId}
        target={{ productId: p.productId, name: p.name, unitCode: p.unitCode, onHand: p.onHand }}
        onDone={() => { setAdjustOpen(false); load(); }} />

      <Sheet open={Boolean(reverseTarget)} onClose={() => setReverseTarget(null)} title="Đảo bút toán này?"
        footer={
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn--outline" onClick={() => setReverseTarget(null)} style={{ flex: 1 }}>Hủy</button>
            <div style={{ flex: 1 }}><Button variant="danger" loading={busy} onClick={doReverse}>Đảo bút toán</Button></div>
          </div>
        }>
        <div className="muted">
          {reverseTarget && (
            <>Tạo một bút toán ngược ({fmtDelta(-reverseTarget.quantityDelta)}) để hoàn tác <b>{movementLabel(reverseTarget.movementType)}</b>. Bút toán gốc được giữ nguyên để truy vết. Không thể đảo hai lần.</>
          )}
        </div>
      </Sheet>
    </div>
  );
}
