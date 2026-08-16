// Functional 09 screens 3.3–3.8 — one lifecycle screen driven by invoice.status:
// seller readiness → buyer info → lines & tax → validate → confirm/submit → đang xử
// lý → accepted (artifacts + relations) / rejected (retry). The server owns totals,
// tax, freeze and state; this screen only presents and confirms. Route: /hoa-don/:id.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMerchant } from "../dashboard/MerchantContext";
import { PageHeader, Button, Banner, LoadingScreen } from "../components/ui";
import { IconReceipt, IconShield, IconInfo, IconRefresh, IconChevron } from "../components/icons";
import { api, ApiError, newIdempotencyKey, fetchText } from "../lib/api";
import type { EInvoice } from "../lib/api";
import {
  RELATION_LABEL, formatVnd, sellerReady, buyerBlockingReason,
} from "../lib/einvoice";
import type { InvoiceBuyer, ValidationError } from "../lib/einvoice";
import { StatusBadge, MockProviderBanner, BuyerForm, AcknowledgeSheet, RelationSheet } from "./parts";

const PRIVILEGED = ["owner", "manager"];
const EDITABLE = ["draft", "validation_failed", "validated"];

export function InvoiceDetail() {
  const nav = useNavigate();
  const { id = "" } = useParams();
  const { merchant, role } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const canEdit = role != null && PRIVILEGED.includes(role);

  const [inv, setInv] = useState<EInvoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [buyer, setBuyer] = useState<InvoiceBuyer | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "validate" | "submit" | "retry" | "relation" | "reconcile">(null);
  const [vErrors, setVErrors] = useState<ValidationError[]>([]);
  const [showAck, setShowAck] = useState(false);
  const [showRelation, setShowRelation] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apply = useCallback((next: EInvoice) => {
    setInv(next);
    setBuyer(next.buyerSnapshot);
    setDirty(false);
  }, []);

  const load = useCallback(async () => {
    if (!merchantId || !id) return;
    try {
      const res = await api.einvoiceGet(merchantId, id);
      apply(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tải được hóa đơn.");
    } finally {
      setLoading(false);
    }
  }, [merchantId, id, apply]);

  useEffect(() => { void load(); }, [load]);

  // Poll while the provider is processing; stop on any terminal state (spec 3.7).
  useEffect(() => {
    if (!inv || inv.status !== "submitting") return;
    let delay = 2500;
    const tick = async () => {
      try {
        const s = await api.einvoiceStatus(merchantId, id, true);
        if (s.status !== "submitting") { await load(); return; }
      } catch { /* keep polling */ }
      delay = Math.min(delay * 1.5, 10000);
      pollRef.current = setTimeout(tick, delay);
    };
    pollRef.current = setTimeout(tick, delay);
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [inv, merchantId, id, load]);

  async function saveBuyer(): Promise<EInvoice | null> {
    if (!inv || !buyer) return inv;
    setBusy("save");
    setError(null);
    try {
      const res = await api.einvoiceSaveBuyer(merchantId, id, buyer, inv.rowVersion);
      apply(res);
      return res;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không lưu được thông tin người mua.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function runValidate() {
    if (!inv) return;
    setBusy("validate");
    setError(null);
    setVErrors([]);
    try {
      let version = inv.rowVersion;
      if (dirty && buyer) {
        const saved = await api.einvoiceSaveBuyer(merchantId, id, buyer, inv.rowVersion);
        version = saved.rowVersion;
        apply(saved);
      }
      const res = await api.einvoiceValidate(merchantId, id, version);
      apply(res.invoice);
      if (!res.ok) setVErrors(res.errors);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không kiểm tra được hóa đơn.");
    } finally {
      setBusy(null);
    }
  }

  async function runSubmit() {
    if (!inv) return;
    setBusy("submit");
    setError(null);
    try {
      await api.einvoiceSubmit(merchantId, id, {
        expectedVersion: inv.rowVersion,
        acknowledgements: { buyer_reviewed: true, amounts_reviewed: true },
      }, newIdempotencyKey());
      setShowAck(false);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không phát hành được hóa đơn.");
    } finally {
      setBusy(null);
    }
  }

  async function runRetry() {
    setBusy("retry");
    setError(null);
    try {
      const res = await api.einvoiceRetryDraft(merchantId, id, newIdempotencyKey());
      nav(`/hoa-don/${res.invoice.id}`, { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tạo được bản gửi lại.");
      setBusy(null);
    }
  }

  async function runRelation(relationType: "adjustment" | "replacement", reason: string) {
    setBusy("relation");
    setError(null);
    try {
      const res = await api.einvoiceCreateRelation(merchantId, id, { relationType, reason }, newIdempotencyKey());
      setShowRelation(false);
      nav(`/hoa-don/${res.invoice.id}`, { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tạo được bản điều chỉnh/thay thế.");
      setBusy(null);
    }
  }

  async function reconcile() {
    setBusy("reconcile");
    try { await api.einvoiceStatus(merchantId, id, true); await load(); }
    catch { /* ignore */ }
    finally { setBusy(null); }
  }

  async function simulate(decision: "accept" | "reject") {
    setBusy("reconcile");
    setError(null);
    try {
      await api.einvoiceSimulate(merchantId, { invoiceId: id, decision, rejectCode: "BUYER_TAX_ID_INVALID" });
      await load();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404
        ? "Điểm mô phỏng chỉ bật ở môi trường phát triển (SOHO_DEV_ENDPOINTS=1)."
        : (e instanceof ApiError ? e.message : "Mô phỏng thất bại."));
    } finally {
      setBusy(null);
    }
  }

  async function downloadArtifact(type: "xml" | "pdf") {
    try {
      const text = await fetchText(api.einvoiceArtifactUrl(merchantId, id, type));
      const blob = new Blob([text], { type: type === "xml" ? "application/xml" : "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${inv?.providerInvoiceRef || id}.${type === "xml" ? "xml" : "pdf.txt"}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Không tải được tệp hóa đơn.");
    }
  }

  if (loading && !inv) return <LoadingScreen />;
  if (!inv) return (
    <div className="screen">
      <PageHeader title="Hóa đơn" onBack={() => nav("/hoa-don")} />
      <div className="content--plain"><Banner kind="error">{error || "Không tìm thấy hóa đơn."}</Banner></div>
    </div>
  );

  const seller = inv.sellerSnapshot;
  const readySeller = sellerReady(seller);
  const editing = canEdit && EDITABLE.includes(inv.status);
  const buyerReason = buyer ? buyerBlockingReason(buyer) : null;

  return (
    <div className="screen">
      <PageHeader title="Chi tiết hóa đơn" onBack={() => nav("/hoa-don")} />
      <div className="content--plain stack" style={{ paddingBottom: 24 }}>
        <MockProviderBanner />

        {/* Status header */}
        <div className="card">
          <div className="row-between">
            <div className="list-row__t">{inv.providerInvoiceRef || "Chưa có mã tra cứu"}</div>
            <StatusBadge status={inv.status} />
          </div>
          <div className="stat-card__value" style={{ fontSize: 26, marginTop: 6 }}>{formatVnd(inv.totalVnd)}</div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
            Bộ quy tắc thuế: {inv.ruleSetVersion}
          </div>
        </div>

        {error && <div className="banner banner--error">{error}</div>}

        {/* Seller readiness (spec 3.3) */}
        <div className="card">
          <div className="section-title" style={{ marginBottom: 8 }}>Người bán</div>
          <ReadyRow ok={Boolean(seller.legalName)} label="Tên người bán" value={seller.legalName || "Chưa có"} />
          <ReadyRow ok={Boolean(seller.taxCode)} label="Mã số thuế (MST)" value={seller.taxCode || "Chưa có"} />
          {!readySeller && (
            <button className="banner banner--warn banner--tap" style={{ marginTop: 10 }} onClick={() => nav("/cai-dat")}>
              Hồ sơ phát hành chưa đủ. Hoàn tất MST trong Cài đặt để phát hành.
            </button>
          )}
        </div>

        {/* Buyer info (spec 3.4) */}
        <div className="card">
          <div className="section-title" style={{ marginBottom: 8 }}>Người mua</div>
          {editing && buyer ? (
            <>
              <BuyerForm buyer={buyer} onChange={(b) => { setBuyer(b); setDirty(true); }} />
              {dirty && (
                <div style={{ marginTop: 10 }}>
                  <Button variant="outline" onClick={saveBuyer} loading={busy === "save"}>Lưu thông tin người mua</Button>
                </div>
              )}
            </>
          ) : (
            <>
              <ReadyRow ok label="Loại" value={inv.buyerSnapshot.kind === "organization" ? "Tổ chức" : "Cá nhân"} />
              <ReadyRow ok label="Tên" value={inv.buyerSnapshot.name || "Khách lẻ"} />
              {inv.buyerSnapshot.taxCode && <ReadyRow ok label="MST" value={inv.buyerSnapshot.taxCode} />}
              {inv.buyerSnapshot.email && <ReadyRow ok label="Email" value={inv.buyerSnapshot.email} />}
            </>
          )}
        </div>

        {/* Lines & tax (spec 3.5) */}
        <div className="card">
          <div className="section-title" style={{ marginBottom: 8 }}>Dòng hàng & thuế</div>
          {inv.items.map((it) => (
            <div key={it.id} className="row-between" style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
              <div style={{ flex: 1 }}>
                <div className="list-row__t" style={{ fontSize: 14 }}>{it.description}</div>
                <div className="muted tiny">
                  {it.quantity} × {formatVnd(it.unitPriceVnd)} · <span className="pill pill--archived" style={{ marginLeft: 0 }}>{it.taxLabel}</span>
                </div>
              </div>
              <b style={{ fontSize: 14 }}>{formatVnd(it.lineTotalVnd)}</b>
            </div>
          ))}
          <TotalRow label="Tạm tính (chưa thuế)" value={inv.subtotalVnd} />
          <TotalRow label="Thuế GTGT" value={inv.taxVnd} />
          <TotalRow label="Tổng cộng" value={inv.totalVnd} strong />
        </div>

        {/* Validation errors (spec 3.5, INV-04/05) */}
        {inv.status === "validation_failed" && vErrors.length > 0 && (
          <div className="card" style={{ borderColor: "var(--danger)" }}>
            <div className="section-title" style={{ marginBottom: 8, color: "var(--danger)" }}>Cần sửa trước khi phát hành</div>
            {vErrors.map((e, i) => (
              <div key={i} className="list-row__d" style={{ padding: "3px 0" }}>• {e.message}</div>
            ))}
          </div>
        )}

        {/* Rejected: provider message + retry (spec 3.7 / 4.3) */}
        {inv.status === "rejected" && (
          <div className="card" style={{ borderColor: "var(--danger)" }}>
            <div className="section-title" style={{ marginBottom: 6, color: "var(--danger)" }}>Bị từ chối</div>
            <div className="list-row__d">
              {inv.submissions[inv.submissions.length - 1]?.providerMessage || "Nhà cung cấp từ chối hóa đơn."}
            </div>
            {canEdit && (
              <div style={{ marginTop: 10 }}>
                <Button variant="primary" onClick={runRetry} loading={busy === "retry"}>Sửa và gửi lại</Button>
              </div>
            )}
          </div>
        )}

        {/* Accepted: artifacts + relations (spec 3.8) */}
        {inv.status === "accepted" && (
          <div className="card">
            <div className="section-title" style={{ marginBottom: 8 }}>Tệp hóa đơn (thử nghiệm)</div>
            <div style={{ display: "flex", gap: 10 }}>
              <Button variant="outline" onClick={() => downloadArtifact("xml")}>Tải XML</Button>
              <Button variant="outline" onClick={() => downloadArtifact("pdf")}>Tải PDF</Button>
            </div>
            {canEdit && (
              <div style={{ marginTop: 12 }}>
                <Button variant="ghost" onClick={() => setShowRelation(true)}>Điều chỉnh / Thay thế</Button>
              </div>
            )}
          </div>
        )}

        {/* Processing timeline + reconcile (spec 3.7) */}
        {inv.status === "submitting" && (
          <div className="card">
            <div className="section-title" style={{ marginBottom: 8 }}>Đang xử lý</div>
            <div className="list-row__d">
              Đã gửi tới nhà cung cấp. Trạng thái “Đã phát hành” chỉ hiển thị khi có
              sự kiện đã xác minh. Mã lần gửi: {inv.submissions[inv.submissions.length - 1]?.clientRequestId || "-"}
            </div>
            <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Button variant="outline" onClick={reconcile} loading={busy === "reconcile"}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><IconRefresh size={16} /> Kiểm tra lại</span>
              </Button>
            </div>
            {/* Dev-only mock decision (server enforces SOHO_DEV_ENDPOINTS). */}
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px dashed var(--line)" }}>
              <div className="muted tiny" style={{ marginBottom: 6 }}>Công cụ thử nghiệm — mô phỏng sự kiện nhà cung cấp:</div>
              <div style={{ display: "flex", gap: 10 }}>
                <Button variant="outline" onClick={() => simulate("accept")}>Mô phỏng: Chấp nhận</Button>
                <Button variant="outline" onClick={() => simulate("reject")}>Mô phỏng: Từ chối</Button>
              </div>
            </div>
          </div>
        )}

        {/* Relation chain */}
        {inv.relations.length > 0 && (
          <div className="card">
            <div className="section-title" style={{ marginBottom: 8 }}>Chuỗi liên quan</div>
            {inv.relations.map((r) => {
              const other = r.direction === "outgoing" ? r.relatedInvoiceId : r.originalInvoiceId;
              return (
                <button
                  key={r.id}
                  className="row-between"
                  style={{ width: "100%", padding: "8px 0", background: "none", border: "none", borderBottom: "1px solid var(--line)", textAlign: "left" }}
                  onClick={() => other && nav(`/hoa-don/${other}`)}
                >
                  <div>
                    <div className="list-row__t" style={{ fontSize: 14 }}>
                      {RELATION_LABEL[r.relationType] || r.relationType}
                      {r.direction === "incoming" ? " (từ bản gốc)" : ""}
                    </div>
                    <div className="muted tiny">{r.reason}</div>
                  </div>
                  {other && <IconChevron size={16} />}
                </button>
              );
            })}
          </div>
        )}

        {/* Source bill (spec 3.8) */}
        <button className="card card--flat row-between" style={{ width: "100%", textAlign: "left" }} onClick={() => nav(`/don-hang/${inv.orderId}`)}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="list-row__ic"><IconReceipt size={18} /></div>
            <div className="list-row__t" style={{ fontSize: 14 }}>Bill nguồn</div>
          </div>
          <IconChevron size={16} />
        </button>
      </div>

      {/* Primary CTA per state (spec 3.5/3.6) */}
      {canEdit && (inv.status === "draft" || inv.status === "validation_failed") && (
        <div className="form-foot">
          <Button
            variant="primary"
            onClick={runValidate}
            loading={busy === "validate"}
            disabled={!readySeller || Boolean(buyerReason)}
            disabledReason={!readySeller ? "Hoàn tất MST người bán trong Cài đặt." : buyerReason || undefined}
          >
            Kiểm tra hợp lệ
          </Button>
        </div>
      )}
      {canEdit && inv.status === "validated" && (
        <div className="form-foot">
          <Button variant="primary" onClick={() => setShowAck(true)}>Phát hành hóa đơn</Button>
        </div>
      )}

      <AcknowledgeSheet open={showAck} onClose={() => setShowAck(false)} onConfirm={runSubmit} submitting={busy === "submit"} />
      <RelationSheet open={showRelation} onClose={() => setShowRelation(false)} onConfirm={runRelation} busy={busy === "relation"} />
    </div>
  );
}

function ReadyRow({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <div className="row-between" style={{ padding: "5px 0" }}>
      <span className="list-row__d" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: ok ? "var(--teal-700)" : "var(--amber)" }}>{ok ? <IconShield size={14} /> : <IconInfo size={14} />}</span>
        {label}
      </span>
      <span className="list-row__t" style={{ fontSize: 13.5 }}>{value}</span>
    </div>
  );
}

function TotalRow({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="row-between" style={{ padding: "6px 0", fontWeight: strong ? 800 : 500, fontSize: strong ? 16 : 14 }}>
      <span className={strong ? "" : "muted"}>{label}</span>
      <span>{formatVnd(value)}</span>
    </div>
  );
}
