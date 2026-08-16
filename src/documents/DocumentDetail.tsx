// Document detail (Functional 08, spec 3.5). One place to view the immutable
// source (short-lived signed URL), its metadata, its links to business records
// (open / add / remove), the retention + legal-hold state, and — for owner/
// manager — the access history. The source file is NEVER editable here.
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader, LoadingScreen, EmptyState, Button } from "../components/ui";
import { InlineError } from "../sales/ui";
import {
  IconFile, IconLink, IconChevron, IconTrash, IconDownload, IconArchive, IconLock, IconAlert,
} from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api, ApiError } from "../lib/api";
import type { DocDetailResult, DocLink } from "../lib/api";
import { docTypeLabel, docStatusLabel, formatBytes, formatDocDate, linkTypeLabel } from "../lib/documents";
import { TypeBadge, StatusBadge, LinkSheet } from "./parts";

export function DocumentDetail() {
  const nav = useNavigate();
  const { id = "" } = useParams();
  const { merchant, role } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const canManage = role === "owner" || role === "manager";
  const canLink = canManage || role === "cashier";

  const [detail, setDetail] = useState<DocDetailResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [viewErr, setViewErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [showAccess, setShowAccess] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadDetail = useCallback(async () => {
    if (!merchantId || !id) return;
    setLoading(true); setNotFound(false);
    try {
      const d = await api.documentGet(merchantId, id);
      setDetail(d);
    } catch (e) {
      if (e instanceof ApiError && (e.code === "DOCUMENT_NOT_FOUND" || e.status === 404)) setNotFound(true);
      else setError(e instanceof ApiError ? e.message : "Không tải được chứng từ.");
    } finally { setLoading(false); }
  }, [merchantId, id]);

  useEffect(() => { void loadDetail(); }, [loadDetail]);

  // Fetch a short-lived signed URL for the preview (server logs the access event).
  useEffect(() => {
    if (!detail) return;
    const st = detail.document.status;
    if (st === "quarantined" || st === "purged") { setViewErr(docStatusLabel(st)); return; }
    let active = true;
    api.documentContent(merchantId, id, "preview")
      .then((r) => { if (active) setViewUrl(r.url); })
      .catch(() => { if (active) setViewErr("Không mở được ảnh."); });
    return () => { active = false; };
  }, [detail, merchantId, id]);

  async function download() {
    try {
      const r = await api.documentContent(merchantId, id, "download");
      window.open(r.url, "_blank", "noopener");
    } catch (e) { setError(e instanceof ApiError ? e.message : "Không tải được tệp."); }
  }

  async function removeLink(link: DocLink) {
    if (!link.linkId) return;
    setBusy(true); setError(null);
    try {
      await api.documentRemoveLink(merchantId, id, link.linkId);
      await loadDetail();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Không gỡ được liên kết."); }
    finally { setBusy(false); }
  }

  async function toggleArchive(action: "archive" | "restore") {
    if (!detail) return;
    setBusy(true); setError(null);
    try {
      await api.documentArchive(merchantId, id, action, detail.document.rowVersion);
      await loadDetail();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Không đổi được trạng thái."); }
    finally { setBusy(false); }
  }

  if (loading && !detail) return <LoadingScreen />;
  if (notFound) return (
    <div className="screen">
      <PageHeader title="Chứng từ" onBack={() => nav("/chung-tu")} />
      <div className="content"><EmptyState icon={<IconFile size={28} />} title="Không tìm thấy chứng từ" desc="Chứng từ có thể đã bị xóa hoặc bạn không có quyền xem." /></div>
    </div>
  );
  if (!detail) return null;

  const doc = detail.document;
  const isArchived = doc.status === "archived";
  const blocked = doc.status === "quarantined" || doc.status === "purged";

  return (
    <div className="screen">
      <PageHeader title="Chứng từ" onBack={() => nav("/chung-tu")}
        right={!blocked ? <button className="step__back" aria-label="Tải tệp gốc" onClick={download}><IconDownload size={19} /></button> : undefined} />
      <div className="content" style={{ paddingBottom: 24 }}>
        {error && <InlineError message={error} onClose={() => setError(null)} />}

        {isArchived && (
          <div className="banner banner--warn banner--tap" style={{ marginBottom: 12 }}>
            <span>Chứng từ đã được lưu trữ (ẩn khỏi danh sách mặc định).</span>
            {canManage && <button className="link-btn" onClick={() => toggleArchive("restore")} disabled={busy}>Khôi phục</button>}
          </div>
        )}

        {/* Preview */}
        <div className="doc-viewer">
          {blocked ? (
            <div className="doc-viewer__ph"><IconLock size={26} /><div style={{ marginTop: 8 }}>{docStatusLabel(doc.status)} — không thể xem.</div></div>
          ) : viewUrl ? (
            <img src={viewUrl} alt={doc.documentNumber || "Chứng từ"} />
          ) : viewErr ? (
            <div className="doc-viewer__ph"><IconAlert size={24} /><div style={{ marginTop: 8 }}>{viewErr}</div></div>
          ) : (
            <div className="doc-viewer__ph"><div className="spinner" /></div>
          )}
        </div>

        {/* Metadata */}
        <div className="doc-card__tags" style={{ margin: "12px 2px 4px" }}>
          <TypeBadge type={doc.documentType} />
          <StatusBadge status={doc.status} />
          {doc.legalHold && <span className="dbadge dbadge--hold"><IconLock size={11} /> Giữ pháp lý</span>}
        </div>
        <div className="stack" style={{ gap: 6, marginTop: 8 }}>
          {doc.documentNumber && <div className="kv"><span>Số chứng từ</span><b>{doc.documentNumber}</b></div>}
          <div className="kv"><span>Loại</span><b>{docTypeLabel(doc.documentType)}</b></div>
          <div className="kv"><span>Ngày nhận</span><b>{formatDocDate(doc.capturedAt, true)}</b></div>
          <div className="kv"><span>Kích thước</span><b>{formatBytes(doc.byteSize)} · {(doc.mimeType || "").replace("image/", "").toUpperCase()}</b></div>
          {doc.retainUntil && <div className="kv"><span>Lưu đến</span><b>{formatDocDate(doc.retainUntil)}</b></div>}
          {doc.sha256 && <div className="kv"><span>Mã băm (SHA-256)</span><b style={{ fontFamily: "monospace", fontSize: 11 }}>{doc.sha256.slice(0, 12)}…</b></div>}
        </div>

        {/* Links */}
        <div className="sect-title">Liên kết nghiệp vụ</div>
        <div className="stack" style={{ gap: 8 }}>
          {detail.links.length === 0 && <div className="muted" style={{ fontSize: 13, padding: "2px 2px 6px" }}>Chưa liên kết với bản ghi nào.</div>}
          {detail.links.map((l, i) => (
            <div className="doc-link-row" key={l.linkId || `${l.targetType}-${l.targetId}-${i}`}>
              <div className="doc-link-row__main" onClick={() => l.route && nav(l.route)} style={{ cursor: l.route ? "pointer" : "default" }}>
                <div className="doc-link-row__t">
                  <IconLink size={14} /> {l.targetLabel}{l.number ? ` · ${l.number}` : ""}
                  {l.missing && <span className="dbadge dbadge--warn">đã thay đổi</span>}
                </div>
                <div className="doc-link-row__d">
                  {linkTypeLabel(l.linkType)}{l.source === "auto" ? " · tự động" : ""}
                </div>
              </div>
              {l.route && <IconChevron size={18} color="#9aa7b4" />}
              {canManage && l.removable && (
                <button className="doc-link-row__x" aria-label="Gỡ liên kết" disabled={busy} onClick={() => removeLink(l)}><IconTrash size={16} /></button>
              )}
            </div>
          ))}
          {canLink && !blocked && (
            <button className="ai-shortcut" onClick={() => setLinkOpen(true)}><IconLink size={16} /> Liên kết nghiệp vụ</button>
          )}
        </div>

        {/* Access history (owner/manager) */}
        {canManage && (
          <>
            <button className="sect-title" style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer" }}
              onClick={() => setShowAccess((s) => !s)}>
              Lịch sử truy cập <IconChevron size={14} style={{ transform: showAccess ? "rotate(90deg)" : "none" }} />
            </button>
            {showAccess && (
              <div className="card card--flat" style={{ padding: "4px 12px" }}>
                {detail.access.length === 0 ? (
                  <div className="muted" style={{ fontSize: 13, padding: 10 }}>Chưa có lượt xem nào được ghi.</div>
                ) : detail.access.map((a, i) => (
                  <div className="doc-access" key={i}>
                    <span className="doc-access__a">{accessLabel(a.action)}{a.actorName ? ` · ${a.actorName}` : ""}</span>
                    <span className="doc-access__m">{formatDocDate(a.createdAt, true)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Lifecycle */}
        {canManage && !blocked && !isArchived && (
          <div style={{ marginTop: 20 }}>
            <Button variant="outline" loading={busy} onClick={() => toggleArchive("archive")}>
              <IconArchive size={16} /> Đưa vào lưu trữ
            </Button>
          </div>
        )}
      </div>

      <LinkSheet open={linkOpen} onClose={() => setLinkOpen(false)} merchantId={merchantId} documentId={id}
        onLinked={() => { setLinkOpen(false); void loadDetail(); }} />
    </div>
  );
}

function accessLabel(action: string): string {
  switch (action) {
    case "preview": return "Xem";
    case "download": return "Tải tệp";
    case "link": return "Liên kết";
    case "purge": return "Xóa";
    default: return action;
  }
}
