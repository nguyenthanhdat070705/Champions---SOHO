// Functional 08 — shared document-box UI: type/status/link badges, the upload
// sheet (pick → preview → classify → upload, with the duplicate override), and
// the link sheet (pick a business record → link_type → create link).
import { useEffect, useRef, useState } from "react";
import { Sheet } from "../sales/ui";
import { SelectField, Button } from "../components/ui";
import { InlineError } from "../sales/ui";
import { IconCamera, IconFile, IconLink, IconSearch } from "../components/icons";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import type { DocSummary, DocType, DocLink, DocLinkCandidate } from "../lib/api";
import {
  ACCEPT_ATTR, DOC_TYPE_OPTIONS, docTypeLabel, docTypeTone, docStatusLabel,
  LINK_TYPE_OPTIONS, TARGET_TYPE_OPTIONS, checkFile, fileToBase64, formatDocDate,
} from "../lib/documents";
import { useDebounced } from "../catalog/parts";

// ── Badges ────────────────────────────────────────────────────────────────────
export function TypeBadge({ type }: { type: DocType | null | undefined }) {
  return <span className={`dbadge dbadge--${docTypeTone(type)}`}>{docTypeLabel(type)}</span>;
}

export function StatusBadge({ status }: { status: DocSummary["status"] }) {
  if (status === "ready") return null; // the common case needs no chip
  const tone = status === "quarantined" ? "warn" : status === "archived" ? "grey" : "amber";
  return <span className={`dbadge dbadge--${tone}`}>{docStatusLabel(status)}</span>;
}

/** "Đã liên kết · Chi phí CP-0001" — always names the type + business code (spec 3.1). */
export function LinkBadge({ link, count }: { link: DocLink; count?: number }) {
  const extra = count && count > 1 ? ` +${count - 1}` : "";
  const code = link.number ? ` ${link.number}` : "";
  return (
    <span className="dbadge dbadge--link">
      <IconLink size={11} /> {link.targetLabel}{code}{extra}
    </span>
  );
}

// ── Upload sheet ────────────────────────────────────────────────────────────
type Picked = { file: File; previewUrl: string; base64: string; mime: string; size: number };

export function UploadSheet({
  open, onClose, merchantId, onUploaded,
}: {
  open: boolean; onClose: () => void; merchantId: string;
  onUploaded: (doc: DocSummary) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [docType, setDocType] = useState<DocType | "">("");
  const [docNumber, setDocNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dup, setDup] = useState<{ id: string; doc: DocSummary } | null>(null);
  const idemRef = useRef<string>(newIdempotencyKey());

  useEffect(() => {
    if (!open) {
      setPicked((p) => { if (p) URL.revokeObjectURL(p.previewUrl); return null; });
      setDocType(""); setDocNumber(""); setError(null); setDup(null); setBusy(false);
    }
  }, [open]);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    const check = checkFile(file.type, file.size);
    if (!check.ok) { setError(check.reason || "Tệp không hợp lệ."); return; }
    setError(null); setDup(null);
    idemRef.current = newIdempotencyKey();
    try {
      const base64 = await fileToBase64(file);
      setPicked({ file, previewUrl: URL.createObjectURL(file), base64, mime: file.type, size: file.size });
    } catch { setError("Không đọc được tệp."); }
  }

  async function doUpload(force: boolean) {
    if (!picked) return;
    setBusy(true); setError(null);
    try {
      const res = await api.documentUpload(merchantId, {
        fileBase64: picked.base64, mimeType: picked.mime,
        documentType: docType || null, documentNumber: docNumber.trim() || undefined, force,
      }, idemRef.current);
      onUploaded(res.document);
    } catch (e) {
      if (e instanceof ApiError && e.code === "DOCUMENT_ALREADY_EXISTS") {
        const d = (e.details as { existingDocumentId?: string; document?: DocSummary }) || {};
        if (d.existingDocumentId && d.document) { setDup({ id: d.existingDocumentId, doc: d.document }); }
        else setError(e.message);
      } else {
        setError(e instanceof ApiError ? e.message : "Không tải lên được. Vui lòng thử lại.");
      }
    } finally { setBusy(false); }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Thêm chứng từ">
      <input ref={fileRef} type="file" accept={ACCEPT_ATTR} hidden onChange={onPick} />
      <input ref={cameraRef} type="file" accept={ACCEPT_ATTR} capture="environment" hidden onChange={onPick} />

      {error && <InlineError message={error} onClose={() => setError(null)} />}

      {dup ? (
        <div className="stack">
          <div className="banner banner--warn">Chứng từ này đã có trong Hộp chứng từ (trùng nội dung).</div>
          <div className="doc-upload-preview"><img src={picked?.previewUrl} alt="Ảnh đã chọn" /></div>
          <Button variant="navy" onClick={() => { onUploaded(dup.doc); }}>Dùng bản đã có</Button>
          <Button variant="outline" loading={busy} onClick={() => doUpload(true)}>Vẫn tải bản mới</Button>
        </div>
      ) : !picked ? (
        <div className="stack">
          <p className="muted" style={{ fontSize: 13, margin: "0 0 4px" }}>
            Chụp hoặc chọn ảnh hóa đơn, phiếu nhập, chứng từ chi… (JPG, PNG, WEBP • tối đa 10 MB).
          </p>
          <button className="ai-shortcut" onClick={() => cameraRef.current?.click()}>
            <IconCamera size={18} /> Chụp ảnh
          </button>
          <button className="ai-shortcut" onClick={() => fileRef.current?.click()}>
            <IconFile size={18} /> Chọn ảnh có sẵn
          </button>
        </div>
      ) : (
        <div className="stack">
          <div className="doc-upload-preview"><img src={picked.previewUrl} alt="Ảnh đã chọn" /></div>
          <SelectField label="Loại chứng từ (gợi ý)" value={docType}
            onChange={(v) => setDocType(v as DocType)} options={DOC_TYPE_OPTIONS}
            placeholder="Chưa phân loại" hint="Có thể để trống, sửa sau." />
          <div className="field">
            <label className="field__label">Số chứng từ <span className="field__opt"> (không bắt buộc)</span></label>
            <input className="input" value={docNumber} onChange={(e) => setDocNumber(e.target.value)}
              placeholder="VD: HD-00123" maxLength={120} />
          </div>
          <Button variant="navy" loading={busy} onClick={() => doUpload(false)}>Tải lên</Button>
          <button className="link-btn" onClick={() => setPicked(null)} disabled={busy}>Chọn ảnh khác</button>
        </div>
      )}
    </Sheet>
  );
}

// ── Link sheet ──────────────────────────────────────────────────────────────
export function LinkSheet({
  open, onClose, merchantId, documentId, onLinked,
}: {
  open: boolean; onClose: () => void; merchantId: string; documentId: string;
  onLinked: (link: DocLink) => void;
}) {
  const [targetType, setTargetType] = useState("order");
  const [linkType, setLinkType] = useState("supporting");
  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState<DocLinkCandidate[]>([]);
  const [selected, setSelected] = useState<DocLinkCandidate | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounced = useDebounced(search, 280);

  useEffect(() => {
    if (!open) { setSelected(null); setSearch(""); setError(null); setLinkType("supporting"); }
  }, [open]);

  useEffect(() => {
    if (!open || !merchantId) return;
    setLoading(true); setSelected(null);
    api.documentLinkCandidates(merchantId, targetType, debounced.trim() || undefined)
      .then((r) => setCandidates(r.candidates))
      .catch(() => setCandidates([]))
      .finally(() => setLoading(false));
  }, [open, merchantId, targetType, debounced]);

  async function doLink() {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const res = await api.documentAddLink(merchantId, documentId,
        { targetType, targetId: selected.targetId, linkType }, newIdempotencyKey());
      onLinked(res.link);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tạo được liên kết.");
    } finally { setBusy(false); }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Liên kết với nghiệp vụ"
      footer={<Button variant="navy" loading={busy} disabled={!selected}
        disabledReason={!selected ? "Chọn một bản ghi để liên kết." : undefined} onClick={doLink}>Liên kết</Button>}>
      {error && <InlineError message={error} onClose={() => setError(null)} />}
      <div className="seg-scroll" style={{ marginBottom: 10 }}>
        {TARGET_TYPE_OPTIONS.map((o) => (
          <button key={o.value} className={`chip ${targetType === o.value ? "chip--on" : ""}`}
            onClick={() => setTargetType(o.value)}>{o.label}</button>
        ))}
      </div>
      <div className="pos-search" style={{ padding: 0, marginBottom: 10 }}>
        <div className="pos-search__box">
          <IconSearch size={18} />
          <input className="pos-search__input" placeholder="Tìm theo số…" value={search}
            onChange={(e) => setSearch(e.target.value)} inputMode="search" />
        </div>
      </div>
      {loading ? (
        <div className="muted" style={{ textAlign: "center", padding: 20 }}>Đang tải…</div>
      ) : candidates.length === 0 ? (
        <div className="muted" style={{ textAlign: "center", padding: 20 }}>Không tìm thấy bản ghi phù hợp.</div>
      ) : (
        <div className="cat-picker">
          {candidates.map((c) => (
            <button key={c.targetId} className={`doc-linkchip ${selected?.targetId === c.targetId ? "doc-linkchip--on" : ""}`}
              onClick={() => setSelected(c)}>
              <div className="doc-link-row__t">{c.number || "(không số)"}</div>
              <div className="doc-link-row__d">{formatDocDate(c.createdAt)}</div>
            </button>
          ))}
        </div>
      )}
      <SelectField label="Loại liên kết" value={linkType} onChange={setLinkType} options={LINK_TYPE_OPTIONS} />
    </Sheet>
  );
}
