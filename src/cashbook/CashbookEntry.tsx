// Functional 11 — "Chi tiết dòng & nguồn" (spec 3.4) + "Đảo và thay thế" (3.7).
// Explains one entry with its source drill-down and processing timeline. A posted
// entry is immutable — "Sửa sai" opens an independent reversal flow that appends
// an opposite entry + adjustment relation (one reversal only); it never edits the
// original row.
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader, Button, Banner } from "../components/ui";
import { Sheet, InlineError } from "../sales/ui";
import { useMerchant } from "../dashboard/MerchantContext";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import type { CashbookEntryDetail } from "../lib/api";
import { formatVnd } from "../lib/format";
import { METHOD_LABEL, entryTypeLabel, REVERSAL_REASON_OPTIONS } from "../lib/cashbook";
import { DirectionBadge, fmtDateTime } from "./parts";

const STATE_LABEL: Record<string, string> = { posted: "Đã ghi sổ", reversed: "Đã đảo" };

export function CashbookEntry() {
  const nav = useNavigate();
  const { id = "" } = useParams();
  const { merchant, role } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const canManage = role === "owner" || role === "manager";

  const [data, setData] = useState<CashbookEntryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reverseOpen, setReverseOpen] = useState(false);

  const load = useCallback(async () => {
    if (!merchantId || !id) return;
    setLoading(true); setError(null);
    try { setData(await api.cashbookEntry(merchantId, id)); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Không tải được dòng sổ."); }
    finally { setLoading(false); }
  }, [merchantId, id]);
  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return (<div className="screen"><PageHeader title="Dòng sổ" onBack={() => nav("/so-quy")} /><div className="muted" style={{ padding: 24, textAlign: "center" }}>Đang tải…</div></div>);
  }
  if (!data) {
    return (<div className="screen"><PageHeader title="Dòng sổ" onBack={() => nav("/so-quy")} /><div className="content--plain">{error && <Banner kind="error">{error}</Banner>}</div></div>);
  }
  const e = data.entry;

  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Chi tiết dòng sổ" onBack={() => nav("/so-quy")} />
      <div className="content--plain cbk">
        {error && <InlineError message={error} onClose={() => setError(null)} />}

        {/* Hero */}
        <div className="cbk-hero">
          <DirectionBadge direction={e.direction} reversed={data.reversed} />
          <div className={`cbk-hero__amt ${e.direction === "in" ? "cbk-amt--in" : "cbk-amt--out"}`}>
            {e.direction === "in" ? "+" : "−"}{formatVnd(e.amountVnd)}
          </div>
          <div className="muted">{entryTypeLabel(e.entryType)}</div>
        </div>

        <div className="card card--flat">
          <div className="kv"><span>Trạng thái</span><b>{STATE_LABEL[e.status] || e.status}</b></div>
          <div className="kv"><span>Phương thức</span><b>{METHOD_LABEL[e.paymentMethod]}</b></div>
          <div className="kv"><span>Ngày nghiệp vụ</span><b>{fmtDateTime(e.occurredAt)}</b></div>
          <div className="kv"><span>Phiên bản quy tắc</span><b>{e.ruleVersion}</b></div>
        </div>

        {/* Nguồn gốc */}
        <div className="section-title" style={{ marginTop: 12 }}>Nguồn gốc</div>
        {data.sources.length === 0 ? (
          <div className="card card--flat"><span className="muted tiny">Dòng điều chỉnh — không có nguồn ngoài.</span></div>
        ) : (
          <div className="stack">
            {data.sources.map((s, i) => (
              <div key={i} className="card card--flat cbk-src-card">
                <div className="cbk-src-card__row"><span className="muted tiny">{s.label}</span><b>{s.sourceEventType}</b></div>
                {s.route ? (
                  <button className="btn btn--outline" style={{ marginTop: 8 }} onClick={() => nav(s.route!)}>Mở nguồn</button>
                ) : (
                  <div className="muted tiny" style={{ marginTop: 6 }}>Không mở được nguồn (đã ẩn theo quyền hoặc là ghi tay).</div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Relations */}
        {data.reversesEntryId && (
          <button className="card card--flat cbk-rel" onClick={() => nav(`/so-quy/${data.reversesEntryId}`)}>
            <span className="muted tiny">Đây là dòng đảo của</span> <b>dòng gốc ›</b>
          </button>
        )}
        {data.reversalEntryId && (
          <button className="card card--flat cbk-rel" onClick={() => nav(`/so-quy/${data.reversalEntryId}`)}>
            <span className="muted tiny">Dòng này đã được đảo bằng</span> <b>dòng đảo ›</b>
          </button>
        )}

        {/* Timeline */}
        <div className="section-title" style={{ marginTop: 12 }}>Dòng thời gian</div>
        <div className="card card--flat">
          {data.timeline.map((t, i) => (
            <div key={i} className="kv"><span>{STATE_LABEL[t.state] || t.state}</span><b>{fmtDateTime(t.at)}</b></div>
          ))}
        </div>

        {/* Sửa sai */}
        {canManage && data.canReverse && (
          <div style={{ marginTop: 16 }}>
            <Button variant="danger" onClick={() => setReverseOpen(true)}>Sửa sai (đảo dòng sổ)</Button>
            <div className="muted tiny" style={{ marginTop: 6, textAlign: "center" }}>Giữ nguyên dòng gốc, thêm một dòng đảo ngược chiều.</div>
          </div>
        )}
        {data.reversed && (
          <div className="muted tiny" style={{ marginTop: 12, textAlign: "center" }}>Dòng này đã được đảo — không thể đảo lại.</div>
        )}
      </div>

      <ReverseSheet open={reverseOpen} onClose={() => setReverseOpen(false)} merchantId={merchantId}
        entryId={e.id} amount={e.amountVnd} direction={e.direction} onDone={() => { setReverseOpen(false); load(); }} />
    </div>
  );
}

function ReverseSheet({
  open, onClose, merchantId, entryId, amount, direction, onDone,
}: {
  open: boolean; onClose: () => void; merchantId: string; entryId: string; amount: number; direction: "in" | "out"; onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!reason || busy) return;
    setBusy(true); setError(null);
    try {
      await api.cashbookReverse(merchantId, entryId, { reasonCode: reason, note: note || undefined }, newIdempotencyKey());
      setReason(""); setNote("");
      onDone();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Không đảo được dòng sổ."); }
    finally { setBusy(false); }
  }

  if (!open) return null;
  return (
    <Sheet open={open} onClose={onClose} title="Đảo dòng sổ">
      {error && <InlineError message={error} onClose={() => setError(null)} />}
      <div className="stack" style={{ marginTop: 4 }}>
        <div className="card card--flat">
          <div className="kv"><span>Dòng gốc</span><b>{direction === "in" ? "Thu" : "Chi"} {formatVnd(amount)}</b></div>
          <div className="kv"><span>Sẽ tạo dòng đảo</span><b>{direction === "in" ? "Chi" : "Thu"} {formatVnd(amount)}</b></div>
        </div>
        <div className="field">
          <label className="field__label">Lý do<span className="field__req"> *</span></label>
          <div className="seg-scroll" style={{ paddingLeft: 0 }}>
            {REVERSAL_REASON_OPTIONS.map((o) => (
              <button key={o.value} className={`chip ${reason === o.value ? "chip--on" : ""}`} onClick={() => setReason(o.value)}>{o.label}</button>
            ))}
          </div>
        </div>
        <div className="field">
          <label className="field__label">Ghi chú <span className="field__opt">(không bắt buộc)</span></label>
          <textarea className="input" rows={2} placeholder="Giải trình…" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="muted tiny">Một dòng chỉ đảo được một lần. Lịch sử được giữ nguyên.</div>
        <Button variant="danger" loading={busy} disabled={!reason} onClick={submit}>Xác nhận đảo</Button>
      </div>
    </Sheet>
  );
}
