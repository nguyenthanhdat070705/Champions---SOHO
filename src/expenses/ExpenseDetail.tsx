// Functional 07 — "Chi tiết & đảo khoản chi" (spec 3.8). Read-only source of truth
// for a posted expense: header, lines, payment fact, document, accounting events
// and any duplicate findings. A posted expense is immutable — correction is the
// reverse flow (đảo bút toán), owner/manager only, with a reason. Never edit/delete.
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader, Button } from "../components/ui";
import { Sheet, InlineError } from "../sales/ui";
import { IconReceipt, IconRefresh, IconAlert } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import type { ExpenseDetail as ExpenseDetailT } from "../lib/api";
import { formatVnd } from "../lib/format";
import { paymentLabel } from "../lib/expenses";
import { StatusBadge } from "./parts";

const EVENT_LABEL: Record<string, string> = {
  expense_posted: "Ghi nhận chi phí",
  expense_reversed: "Đảo bút toán",
};

export function ExpenseDetail() {
  const nav = useNavigate();
  const { id = "" } = useParams();
  const { merchant, role } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const canReverse = role === "owner" || role === "manager";

  const [data, setData] = useState<ExpenseDetailT | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [revOpen, setRevOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  function load() {
    if (!merchantId || !id) return;
    setLoading(true);
    api.getExpense(merchantId, id).then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  }
  useEffect(load, [merchantId, id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function reverse() {
    if (!merchantId || !id || busy) return;
    setBusy(true); setError(null);
    try {
      await api.reverseExpense(merchantId, id, { reason: reason.trim() || "Điều chỉnh sai sót" }, newIdempotencyKey());
      setRevOpen(false); setReason("");
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không đảo được khoản chi.");
    } finally {
      setBusy(false);
    }
  }

  async function decideDup(findingId: string, decision: "dismissed" | "confirmed") {
    if (!merchantId || !id) return;
    try { await api.decideDuplicate(merchantId, id, findingId, decision); load(); }
    catch { /* non-blocking */ }
  }

  if (loading) return <div className="screen"><PageHeader title="Khoản chi" onBack={() => nav(-1)} /><div className="muted" style={{ padding: 30, textAlign: "center" }}>Đang tải…</div></div>;
  if (!data) return <div className="screen"><PageHeader title="Khoản chi" onBack={() => nav(-1)} /><div className="empty" style={{ marginTop: 30 }}><div className="empty__ic"><IconAlert size={26} /></div><div className="empty__t">Không tìm thấy khoản chi</div></div></div>;

  const e = data.expense;
  const openFindings = data.duplicateFindings.filter((f) => f.status === "open");

  return (
    <div className="screen">
      <PageHeader title={e.expenseNumber} onBack={() => nav("/chi-phi")} />
      <div className="content--plain form-scroll">
        {error && <InlineError message={error} onClose={() => setError(null)} />}

        {/* Summary */}
        <div className="card" style={{ textAlign: "center", padding: "16px 12px", marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 6 }}><StatusBadge status={e.status} /></div>
          <div style={{ fontSize: 28, fontWeight: 800, textDecoration: e.status === "reversed" ? "line-through" : "none" }}>{formatVnd(e.grandTotalVnd)}</div>
          <div className="muted tiny" style={{ marginTop: 2 }}>{e.payeeName || "Không tên bên nhận"} · {e.expenseDate}</div>
        </div>

        {e.status === "reversed" && (
          <div className="card card--flat" style={{ background: "#fdeaea", marginBottom: 12 }}>
            <div className="tiny">Khoản chi này đã được đảo. Bản gốc được giữ nguyên; hệ thống đã phát bút toán đảo.</div>
          </div>
        )}

        {openFindings.length > 0 && (
          <div className="card card--flat" style={{ background: "#fdf6e3", marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>⚠︎ Nghi trùng ({openFindings.length})</div>
            {openFindings.map((f) => (
              <div key={f.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 6 }}>
                <div className="tiny">{f.candidate.payeeName || "?"} · {f.candidate.expenseNumber} · {formatVnd(f.candidate.grandTotalVnd)}</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="chip" onClick={() => decideDup(f.id, "dismissed")}>Không trùng</button>
                  <button className="chip chip--on" onClick={() => decideDup(f.id, "confirmed")}>Đúng là trùng</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Fields */}
        <div className="card card--flat" style={{ marginBottom: 12 }}>
          <div className="kv"><span>Nhóm chi</span><b>{e.categoryName || "—"}</b></div>
          <div className="kv"><span>Thanh toán</span><b>{paymentLabel(data.paymentFact?.method ?? null, data.paymentFact?.confirmationStatus ?? null)}</b></div>
          <div className="kv"><span>Số chứng từ</span><b>{e.expenseNumber}</b></div>
          {e.sourceType !== "manual" && <div className="kv"><span>Nguồn</span><b>{e.sourceType}</b></div>}
          {e.postedAt && <div className="kv"><span>Ghi lúc</span><b>{new Date(e.postedAt).toLocaleString("vi-VN")}</b></div>}
        </div>

        {/* Lines */}
        {data.items.length > 0 && (
          <div className="card card--flat" style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Chi tiết dòng</div>
            {data.items.map((it) => (
              <div key={it.id} className="kv"><span>{it.description} × {it.quantity}</span><b>{formatVnd(it.lineTotalVnd)}</b></div>
            ))}
            <div className="kv" style={{ borderTop: "1px solid #eee", marginTop: 4, paddingTop: 6 }}><span>Tạm tính</span><b>{formatVnd(e.subtotalVnd)}</b></div>
            {e.taxAmountVnd > 0 && <div className="kv"><span>Thuế (tham khảo)</span><b>{formatVnd(e.taxAmountVnd)}</b></div>}
          </div>
        )}

        {/* Document */}
        {data.document && (
          <div className="card card--flat" style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 10 }}>
            <IconReceipt size={18} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>Chứng từ đính kèm</div>
              <div className="muted tiny">{data.document.documentNumber || "Ảnh hóa đơn"} · đã lưu bằng chứng</div>
            </div>
          </div>
        )}

        {/* Accounting events (downstream interface) */}
        {data.accountingEvents.length > 0 && (
          <div className="card card--flat" style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Bút toán</div>
            {data.accountingEvents.map((ev) => (
              <div key={ev.id} className="kv"><span>{EVENT_LABEL[ev.eventType] || ev.eventType}</span><b>{formatVnd(ev.amountVnd)} · {ev.reviewStatus}</b></div>
            ))}
          </div>
        )}
      </div>

      {e.status === "posted" && canReverse && (
        <div className="form-foot">
          <button className="btn btn--outline" onClick={() => setRevOpen(true)}><IconRefresh size={15} /> Đảo khoản chi</button>
        </div>
      )}

      <Sheet open={revOpen} onClose={() => setRevOpen(false)} title="Đảo khoản chi">
        <div className="muted" style={{ marginBottom: 10 }}>
          Đảo bút toán sẽ phát một bút toán đảo và giữ nguyên bản gốc. Không thể sửa/xóa khoản chi đã ghi.
        </div>
        <div className="field">
          <label className="field__label">Lý do đảo</label>
          <textarea className="input" rows={2} placeholder="VD: ghi nhầm số tiền…" value={reason} onChange={(e2) => setReason(e2.target.value)} />
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <button className="btn btn--outline" onClick={() => setRevOpen(false)} style={{ flex: 1 }}>Hủy</button>
          <div style={{ flex: 1 }}><Button variant="danger" loading={busy} onClick={reverse}>Xác nhận đảo</Button></div>
        </div>
      </Sheet>
    </div>
  );
}
