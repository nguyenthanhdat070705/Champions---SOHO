// The kiểm kho working screen: "Nhập số đếm" → "Đối chiếu" → "Hoàn tất" (spec
// 3.6–3.8), driven by the session status. Counting is blind by default (system
// number hidden). Review reveals expected_at_start AND current_before_post so a
// sale during the count is visible, and forces a reason on every real variance.
// Posting is one atomic server transaction (all-or-nothing); a blank is never
// treated as 0. A posted session is read-only — corrections need a new session.
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader, Button, Banner } from "../components/ui";
import { Sheet, InlineError } from "../sales/ui";
import { IconCheck, IconBox } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import type { CountSessionView, CountItem, CountItemInput, CountPostResult } from "../lib/api";
import { unitLabel } from "../lib/catalog";
import { fmtQty, fmtDelta, parseQty, reasonOptionsFor, reasonComplete, countReadyToPost } from "../lib/inventory";

interface Edit { counted: string; missing: boolean; reason: string; note: string; }
type View = "counting" | "review" | "posted" | "cancelled";
type ReviewFilter = "all" | "up" | "down" | "same" | "uncounted";

function seed(items: CountItem[]): Record<string, Edit> {
  const m: Record<string, Edit> = {};
  for (const it of items) {
    m[it.productId] = {
      counted: it.countedQty != null ? fmtQty(it.countedQty) : "",
      missing: it.missing === true || it.reasonCode === "MISSING",
      reason: it.reasonCode && it.reasonCode !== "MISSING" ? it.reasonCode : "",
      note: it.note ?? "",
    };
  }
  return m;
}

export function CountSession() {
  const nav = useNavigate();
  const { merchant, role } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const canManage = role === "owner" || role === "manager";
  const { id } = useParams();

  const [data, setData] = useState<CountSessionView | null>(null);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [view, setView] = useState<View>("counting");
  const [filter, setFilter] = useState<ReviewFilter>("all");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [postResult, setPostResult] = useState<CountPostResult | null>(null);

  useEffect(() => {
    if (!merchantId || !id) return;
    setLoading(true);
    api.countGet(merchantId, id)
      .then((r) => {
        setData(r);
        setEdits(seed(r.items));
        const st = r.session.status;
        setView(st === "posted" ? "posted" : st === "cancelled" ? "cancelled" : st === "review" ? "review" : "counting");
      })
      .catch(() => setError("Không tải được phiên kiểm kho."))
      .finally(() => setLoading(false));
  }, [merchantId, id]);

  function setEdit(pid: string, patch: Partial<Edit>) {
    setEdits((prev) => ({ ...prev, [pid]: { ...prev[pid], ...patch } }));
  }

  function payload(): CountItemInput[] {
    if (!data) return [];
    return data.items.map((it) => {
      const e = edits[it.productId] ?? { counted: "", missing: false, reason: "", note: "" };
      if (e.missing) return { productId: it.productId, missing: true, note: e.note || null };
      return { productId: it.productId, countedQty: parseQty(e.counted), reasonCode: e.reason || null, note: e.note || null };
    });
  }

  async function saveCounts() {
    if (!merchantId || !id) return;
    await api.countSaveItems(merchantId, id, { items: payload(), expectedRowVersion: data?.session.rowVersion });
  }

  async function goReview() {
    if (!merchantId || !id || busy) return;
    setBusy(true); setError(null);
    try {
      await saveCounts();
      const r = await api.countReview(merchantId, id);
      setData(r); setEdits(seed(r.items)); setView("review");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không xem được đối chiếu.");
    } finally { setBusy(false); }
  }

  async function doPost() {
    if (!merchantId || !id || busy) return;
    setBusy(true); setError(null);
    try {
      await saveCounts();
      const r = await api.countPost(merchantId, id, newIdempotencyKey());
      setPostResult(r); setView("posted");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không hoàn tất được. Vui lòng kiểm tra lý do các dòng lệch.");
    } finally { setBusy(false); }
  }

  async function doCancel() {
    if (!merchantId || !id || busy) return;
    setBusy(true);
    try { await api.countCancel(merchantId, id); nav("/ton-kho/kiem-kho", { replace: true }); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Không hủy được phiên."); setBusy(false); setCancelOpen(false); }
  }

  if (loading) return <div className="screen"><PageHeader title="Kiểm kho" onBack={() => nav("/ton-kho/kiem-kho")} /><div className="muted" style={{ textAlign: "center", padding: 40 }}>Đang tải…</div></div>;
  if (!data) return <div className="screen"><PageHeader title="Kiểm kho" onBack={() => nav("/ton-kho/kiem-kho")} /><InlineError message={error ?? "Không tìm thấy phiên."} /></div>;

  const s = data.session;
  const nameOf = (pid: string) => data.items.find((i) => i.productId === pid)?.name ?? pid;
  const unitOf = (pid: string) => unitLabel(data.items.find((i) => i.productId === pid)?.unitCode);

  const reviewLines = data.items.map((it) => ({
    ...it,
    reasonCode: edits[it.productId]?.reason || null,
    note: edits[it.productId]?.note || null,
  }));
  const canPost = countReadyToPost(reviewLines.map((l) => ({ countedQty: l.countedQty, variance: l.variance, reasonCode: l.reasonCode, note: l.note })));

  return (
    <div className="screen">
      <PageHeader title={s.name} onBack={() => nav("/ton-kho/kiem-kho")}
        right={canManage && view !== "posted" && view !== "cancelled" ? (
          <div style={{ position: "relative" }}>
            <button className="step__back" onClick={() => setMenuOpen((v) => !v)} aria-label="Thêm">⋯</button>
            {menuOpen && (
              <div className="pos-menu" onMouseLeave={() => setMenuOpen(false)}>
                <button onClick={() => { setMenuOpen(false); setCancelOpen(true); }}>Hủy phiên</button>
              </div>
            )}
          </div>
        ) : undefined} />

      <div className="content--plain">
        {error && <InlineError message={error} onClose={() => setError(null)} />}

        {view === "counting" && (
          <>
            {s.blindCount && <Banner kind="info">Đếm mù: số tồn hệ thống được ẩn để không ảnh hưởng người đếm.</Banner>}
            <div className="muted tiny" style={{ margin: "10px 2px" }}>Nhập số đếm thực tế cho từng mặt hàng. Để trống nếu chưa đếm — hệ thống không tự coi là 0.</div>
            <div className="stack">
              {data.items.map((it) => {
                const e = edits[it.productId];
                return (
                  <div key={it.productId} className={`card card--flat count-row ${e?.missing ? "count-row--missing" : ""}`}>
                    <div className="count-row__head">
                      <div className="inv-row__name">{it.name}</div>
                      {it.expectedAtStart !== undefined && <span className="muted tiny">HT: {fmtQty(it.expectedAtStart)}</span>}
                    </div>
                    <div className="count-row__entry">
                      <input className="input count-row__input" inputMode="decimal" placeholder="Số đếm" disabled={e?.missing}
                        value={e?.missing ? "" : (e?.counted ?? "")} onChange={(ev) => setEdit(it.productId, { counted: ev.target.value })} />
                      <span className="muted tiny">{unitOf(it.productId)}</span>
                      <button className={`chip ${e?.missing ? "chip--on" : ""}`} onClick={() => setEdit(it.productId, { missing: !e?.missing })}>Chưa thấy</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {view === "review" && (
          <>
            {data.summary && (
              <div className="card card--flat count-summary">
                <div><b className="up">+{data.summary.increases}</b><span className="muted tiny">tăng</span></div>
                <div><b className="down">−{data.summary.decreases}</b><span className="muted tiny">giảm</span></div>
                <div><b>{data.summary.unchanged}</b><span className="muted tiny">khớp</span></div>
                <div><b>{data.summary.missing}</b><span className="muted tiny">chưa đếm</span></div>
              </div>
            )}
            <div className="seg-scroll">
              {([["all", "Tất cả"], ["up", "Tăng"], ["down", "Giảm"], ["same", "Khớp"], ["uncounted", "Chưa đếm"]] as [ReviewFilter, string][]).map(([k, l]) => (
                <button key={k} className={`chip ${filter === k ? "chip--on" : ""}`} onClick={() => setFilter(k)}>{l}</button>
              ))}
            </div>
            <div className="stack" style={{ marginTop: 10 }}>
              {data.items.filter((it) => matchFilter(it, filter)).map((it) => {
                const e = edits[it.productId];
                const v = it.variance;
                const needsReason = it.requiresReason === true;
                const opts = reasonOptionsFor((v ?? 0) >= 0 ? "increase" : "decrease");
                return (
                  <div key={it.productId} className="card card--flat count-review">
                    <div className="count-review__top">
                      <div className="inv-row__name">{it.name}</div>
                      {it.countedQty == null ? <span className="pill pill--low">Chưa đếm</span>
                        : v === 0 ? <span className="pill pill--active">Khớp</span>
                          : <span className={`count-review__delta ${(v ?? 0) > 0 ? "up" : "down"}`}>{fmtDelta(v ?? 0)}</span>}
                    </div>
                    <div className="count-review__nums muted tiny">
                      Đầu kỳ {fmtQty(it.expectedAtStart)} · Hiện tại {fmtQty(it.currentOnHand)} · Đếm {it.countedQty == null ? "—" : fmtQty(it.countedQty)}
                    </div>
                    {needsReason && (
                      <div style={{ marginTop: 8 }}>
                        <div className="seg-scroll" style={{ paddingLeft: 0 }}>
                          {opts.map((o) => (
                            <button key={o.value} className={`chip ${e?.reason === o.value ? "chip--on" : ""}`} onClick={() => setEdit(it.productId, { reason: o.value })}>{o.label}</button>
                          ))}
                        </div>
                        {e?.reason === "OTHER" && (
                          <textarea className="input" rows={2} style={{ marginTop: 6 }} placeholder="Ghi chú lý do…" value={e?.note ?? ""} onChange={(ev) => setEdit(it.productId, { note: ev.target.value })} />
                        )}
                        {!reasonComplete(e?.reason, e?.note) && <div className="field__error">Chọn lý do cho dòng lệch này.</div>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {view === "posted" && (
          <div className="stack" style={{ marginTop: 10 }}>
            <div className="card count-done">
              <div className="count-done__ic"><IconCheck size={30} color="#fff" /></div>
              <div className="count-done__t">Đã hoàn tất kiểm kho</div>
              <div className="muted">{(postResult?.postedLines ?? 0)} dòng đã điều chỉnh tồn kho.</div>
            </div>
            {postResult && postResult.adjustments.length > 0 && (
              <div className="stack">
                {postResult.adjustments.map((a) => (
                  <div key={a.productId} className="kv"><span>{nameOf(a.productId)}</span><b>{fmtQty(a.before)} → {fmtQty(a.after)} ({fmtDelta(a.delta)})</b></div>
                ))}
              </div>
            )}
          </div>
        )}

        {view === "cancelled" && (
          <div className="empty" style={{ marginTop: 30 }}><div className="empty__ic"><IconBox size={26} /></div><div className="empty__t">Phiên đã hủy</div><div className="empty__d">Phiên kiểm kho này đã bị hủy và không thay đổi tồn kho.</div></div>
        )}
      </div>

      {view === "counting" && canManage && (
        <div className="form-foot">
          <Button variant="primary" loading={busy} onClick={goReview}>Xem đối chiếu</Button>
        </div>
      )}
      {view === "review" && canManage && (
        <div className="form-foot form-foot--split">
          <Button variant="outline" onClick={() => setView("counting")}>Sửa số đếm</Button>
          <Button variant="primary" loading={busy} disabled={!canPost} disabledReason={!canPost ? "Chọn lý do cho mọi dòng lệch." : undefined} onClick={doPost}>Duyệt &amp; hoàn tất</Button>
        </div>
      )}
      {(view === "posted" || view === "cancelled") && (
        <div className="form-foot">
          <Button variant="primary" onClick={() => nav("/ton-kho")}>Về tồn kho</Button>
        </div>
      )}

      <Sheet open={cancelOpen} onClose={() => setCancelOpen(false)} title="Hủy phiên kiểm kho?"
        footer={<div style={{ display: "flex", gap: 10 }}>
          <button className="btn btn--outline" onClick={() => setCancelOpen(false)} style={{ flex: 1 }}>Không</button>
          <div style={{ flex: 1 }}><Button variant="danger" loading={busy} onClick={doCancel}>Hủy phiên</Button></div>
        </div>}>
        <div className="muted">Số đếm đã nhập sẽ bị bỏ và tồn kho không thay đổi. Bạn có thể tạo phiên mới bất cứ lúc nào.</div>
      </Sheet>
    </div>
  );
}

function matchFilter(it: CountItem, f: ReviewFilter): boolean {
  if (f === "all") return true;
  if (f === "uncounted") return it.countedQty == null;
  if (it.countedQty == null) return false;
  const v = it.variance ?? 0;
  if (f === "up") return v > 0;
  if (f === "down") return v < 0;
  if (f === "same") return v === 0;
  return true;
}
