// Functional 14 — confirmed closing detail + revision history + late-source
// attention (spec §3.1 confirmed card, §3.7 late sources, §3.12 history). A
// confirmed revision is READ-ONLY: the only edits are "Chốt lại" (a new revision,
// chained) or dismissing a late source. Owner/manager sees the actions; the
// server enforces the same.
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader, Banner, Button } from "../components/ui";
import { IconAlert, IconLock } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api, ApiError } from "../lib/api";
import { formatVnd, formatBusinessDateVN, formatClockVN } from "../lib/format";
import { signedVnd, reasonLabel } from "../lib/closing";
import type { ClosingDetail as ClosingDetailT } from "../lib/closing";
import { StatusBadge, VarianceHero, DirAmount } from "./parts";

export function ClosingDetail() {
  const nav = useNavigate();
  const { id } = useParams();
  const { merchant, role } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const canManage = role === "owner" || role === "manager";

  const [data, setData] = useState<ClosingDetailT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!merchantId || !id) return;
    setError(null);
    try {
      const d = await api.closingGet(merchantId, id);
      setData(d);
      // Persist any live late sources into attention items + flip status (manager).
      if (canManage && d.lateSources.length > 0 && d.openAttentionCount === 0) {
        await api.closingScanLate(merchantId, id);
        setData(await api.closingGet(merchantId, id));
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tải được bản chốt.");
    }
  }, [merchantId, id, canManage]);

  useEffect(() => { void load(); }, [load]);

  async function dismiss(attentionId: string) {
    if (!merchantId || busy) return;
    setBusy(true); setError(null);
    try {
      await api.closingResolveAttention(merchantId, attentionId, { decision: "dismissed" });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không xử lý được.");
    } finally { setBusy(false); }
  }

  if (!data) {
    return (
      <div className="screen">
        <PageHeader title="Bản chốt ngày" onBack={() => nav("/chot-tien")} />
        <div className="content--plain">
          {error ? <Banner kind="error">{error}</Banner> : <div className="muted" style={{ textAlign: "center", padding: 24 }}>Đang tải…</div>}
        </div>
      </div>
    );
  }

  const { closing, current, revisions, attentionItems } = data;
  const openAttn = attentionItems.filter((a) => a.status === "open");

  return (
    <div className="screen">
      <PageHeader title="Bản chốt ngày" onBack={() => nav("/chot-tien")}
        right={<StatusBadge status={closing.status} />} />
      <div className="content--plain">
        <div className="muted tiny" style={{ marginBottom: 8 }}>{formatBusinessDateVN(closing.businessDate)}</div>
        {error && <Banner kind="error">{error}</Banner>}

        {current && (
          <>
            <VarianceHero expected={current.expectedCashVnd} counted={current.countedCashVnd} variance={current.varianceVnd} />
            <div className="card card--flat" style={{ marginTop: 12 }}>
              <div className="kv"><span>Bản chốt hiện hành</span><b>#{current.revisionNo}</b></div>
              {current.reasonCode && <div className="kv"><span>Lý do lệch</span><b>{current.reasonLabel || reasonLabel(current.reasonCode)}</b></div>}
              {current.reasonNote && <div className="muted tiny">“{current.reasonNote}”</div>}
              <div className="kv"><span>Chốt lúc</span><b>{formatClockVN(current.confirmedAt)}</b></div>
              <div className="cls-lock"><IconLock size={13} /> Bản đã chốt không sửa/xóa — sửa bằng cách chốt lại.</div>
            </div>
          </>
        )}

        {/* Late-source attention (spec §3.7) */}
        {openAttn.length > 0 && (
          <div className="card cls-attn" style={{ marginTop: 14 }}>
            <div className="cls-attn__head"><IconAlert size={16} /> Giao dịch đến muộn ({openAttn.length})</div>
            <div className="muted tiny" style={{ marginBottom: 8 }}>Phát sinh sau khi đã chốt. Chốt lại để đưa vào bản mới, hoặc bỏ qua nếu không thuộc két ngày này.</div>
            <div className="stack">
              {openAttn.map((a) => {
                const ref = a.sourceRef as { amountVnd?: number; route?: string; sourceType?: string };
                const dir = a.impactVnd >= 0 ? "in" : "out";
                return (
                  <div key={a.id} className="card card--flat cls-attn__row">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="cls-attn__lb">{ref.sourceType === "refund" ? "Hoàn tiền mặt" : "Bill tiền mặt"} đến muộn</div>
                      <div className="muted tiny">Ảnh hưởng két</div>
                    </div>
                    <DirAmount direction={dir} amount={Math.abs(ref.amountVnd ?? a.impactVnd)} />
                    {canManage && (
                      <button className="btn btn--ghost cls-attn__dismiss" onClick={() => dismiss(a.id)} disabled={busy}>Bỏ qua</button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Revision history (spec §3.12) */}
        <div className="section-title" style={{ marginTop: 16 }}>Lịch sử chốt</div>
        <div className="stack" style={{ marginTop: 8 }}>
          {revisions.map((r) => (
            <div key={r.id} className={`card card--flat cls-rev ${r.id === closing.currentRevisionId ? "cls-rev--current" : ""}`}>
              <div className="cls-rev__top">
                <b>Bản {r.revisionNo}</b>
                {r.id === closing.currentRevisionId && <span className="cls-badge cls-badge--confirmed">Hiện hành</span>}
                {r.previousRevisionId && <span className="muted tiny">sửa từ bản trước</span>}
              </div>
              <div className="cls-rev__grid">
                <span className="muted tiny">Kỳ vọng {formatVnd(r.expectedCashVnd)}</span>
                <span className="muted tiny">Đã đếm {formatVnd(r.countedCashVnd)}</span>
                <span className={`tiny ${r.varianceVnd === 0 ? "muted" : r.varianceVnd > 0 ? "cls-t--in" : "cls-t--out"}`}>Lệch {signedVnd(r.varianceVnd, formatVnd)}</span>
              </div>
              {r.reasonCode && <div className="muted tiny">Lý do: {r.reasonLabel || reasonLabel(r.reasonCode)}</div>}
              <div className="muted tiny">{formatClockVN(r.confirmedAt)}</div>
            </div>
          ))}
        </div>
      </div>

      {canManage && (
        <div className="form-foot form-foot--split">
          <Button variant="outline" onClick={() => nav("/chot-tien")}>Đóng</Button>
          <Button variant="primary" onClick={() => nav(`/chot-tien/moi?date=${closing.businessDate}`)}>
            Chốt lại (bản sửa đổi)
          </Button>
        </div>
      )}
    </div>
  );
}
