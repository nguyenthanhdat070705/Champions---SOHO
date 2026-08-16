// "Hộp chứng từ" — the document box (Functional 08, spec 3.1). One place to see
// every photo/PDF the store has captured: a searchable, filterable grid with
// thumbnail, date, type badge and a linked-record chip. F6 (Nhập hàng) and F7
// (Chi phí) documents appear here automatically because they share
// source_documents (the list just reads the table). Owner/manager/cashier(policy)
// can add a document via the FAB; the server enforces the same.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader, EmptyState } from "../components/ui";
import { IconFile, IconSearch, IconPlus } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api } from "../lib/api";
import type { DocListResult, DocType, DocLinkedFilter, DocSummary } from "../lib/api";
import { useDebounced } from "../catalog/parts";
import { DOC_TYPE_OPTIONS, formatDocDate } from "../lib/documents";
import { TypeBadge, StatusBadge, LinkBadge, UploadSheet } from "./parts";

const LINK_FILTERS: { key: DocLinkedFilter; label: string }[] = [
  { key: "all", label: "Tất cả" },
  { key: "linked", label: "Đã liên kết" },
  { key: "unlinked", label: "Chưa liên kết" },
];

export function DocumentsPage() {
  const nav = useNavigate();
  const { merchant, role } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const canUpload = role === "owner" || role === "manager" || role === "cashier";

  const [data, setData] = useState<DocListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [linked, setLinked] = useState<DocLinkedFilter>("all");
  const [type, setType] = useState<DocType | "">("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const debouncedSearch = useDebounced(search, 280);

  function load() {
    if (!merchantId) return;
    setLoading(true);
    api.documentsList(merchantId, {
      search: debouncedSearch.trim() || undefined,
      linked, type: type || undefined, limit: 60,
    })
      .then(setData)
      .catch(() => setData({ documents: [], hasMore: false, nextOffset: null, summary: { total: 0, linked: 0, unlinked: 0 } }))
      .finally(() => setLoading(false));
  }
  useEffect(load, [merchantId, debouncedSearch, linked, type]); // eslint-disable-line react-hooks/exhaustive-deps

  const documents = data?.documents ?? [];
  const summary = data?.summary ?? { total: 0, linked: 0, unlinked: 0 };

  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Hộp chứng từ" onBack={() => nav("/")} />
      <div className="content--plain catalog">
        <div className="pos-search" style={{ padding: 0, marginBottom: 10 }}>
          <div className="pos-search__box">
            <IconSearch size={19} />
            <input className="pos-search__input" placeholder="Tìm theo số chứng từ…" value={search}
              onChange={(e) => setSearch(e.target.value)} inputMode="search" />
          </div>
        </div>

        <div className="seg-scroll">
          {LINK_FILTERS.map((f) => {
            const n = f.key === "all" ? summary.total : f.key === "linked" ? summary.linked : summary.unlinked;
            return (
              <button key={f.key} className={`chip ${linked === f.key ? "chip--on" : ""}`} onClick={() => setLinked(f.key)}>
                {f.label}{` (${n})`}
              </button>
            );
          })}
          <span className="seg-scroll__sep" />
          <button className={`chip ${type === "" ? "chip--on" : ""}`} onClick={() => setType("")}>Mọi loại</button>
          {DOC_TYPE_OPTIONS.map((o) => (
            <button key={o.value} className={`chip ${type === o.value ? "chip--on" : ""}`}
              onClick={() => setType(type === o.value ? "" : o.value)}>{o.label}</button>
          ))}
        </div>

        {loading ? (
          <div className="muted" style={{ textAlign: "center", padding: 30 }}>Đang tải…</div>
        ) : documents.length === 0 ? (
          <div style={{ marginTop: 24 }}>
            <EmptyState icon={<IconFile size={28} />}
              title={search || type || linked !== "all" ? "Không tìm thấy chứng từ" : "Chưa có chứng từ nào"}
              desc={search || type || linked !== "all" ? "Thử bỏ bớt bộ lọc hoặc từ khóa khác." : "Bấm “Thêm” để chụp hoặc tải ảnh hóa đơn, phiếu nhập, chứng từ chi."} />
          </div>
        ) : (
          <div className="doc-grid">
            {documents.map((d) => <DocCard key={d.id} doc={d} onClick={() => nav(`/chung-tu/${d.id}`)} />)}
          </div>
        )}
        {data?.hasMore && (
          <div className="muted" style={{ textAlign: "center", padding: 14, fontSize: 13 }}>
            Hiển thị {documents.length} chứng từ mới nhất. Dùng ô tìm để lọc thêm.
          </div>
        )}
      </div>

      {canUpload && (
        <button className="fab" onClick={() => setUploadOpen(true)} aria-label="Thêm chứng từ">
          <IconPlus size={22} /> <span>Thêm</span>
        </button>
      )}

      <UploadSheet open={uploadOpen} onClose={() => setUploadOpen(false)} merchantId={merchantId}
        onUploaded={(doc) => { setUploadOpen(false); nav(`/chung-tu/${doc.id}`); }} />
    </div>
  );
}

function DocCard({ doc, onClick }: { doc: DocSummary; onClick: () => void }) {
  return (
    <button className="doc-card" onClick={onClick}>
      <div className="doc-card__thumb">
        {doc.thumbUrl ? <img src={doc.thumbUrl} alt="" loading="lazy" />
          : <span className="doc-card__ph"><IconFile size={30} /></span>}
        <span className="doc-card__status"><StatusBadge status={doc.status} /></span>
      </div>
      <div className="doc-card__body">
        <div className="doc-card__date">{formatDocDate(doc.capturedAt)}</div>
        {doc.documentNumber && <div className="doc-card__num">{doc.documentNumber}</div>}
        <div className="doc-card__tags">
          <TypeBadge type={doc.documentType} />
          {doc.primaryLink && <LinkBadge link={doc.primaryLink} count={doc.linkCount} />}
          {doc.legalHold && <span className="dbadge dbadge--hold">Đang giữ</span>}
        </div>
      </div>
    </button>
  );
}
