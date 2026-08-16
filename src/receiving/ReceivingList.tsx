// "Phiếu nhập" — the receiving list (spec 3.1). Continue a draft, view a posted
// receipt, or start a new one (Chụp chứng từ / Nhập tay, spec 3.2). Owner/manager
// only (server enforces the same). No AP / công nợ is ever shown — a receipt total
// is document info, not a payment (spec 3.1 rule).
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/ui";
import { Sheet } from "../sales/ui";
import { IconTruck, IconSearch, IconPlus, IconChevron } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import type { ReceiptSummary, DuplicateCandidate, DocumentExtraction } from "../lib/api";
import { useDebounced, fileToBase64 } from "../catalog/parts";
import { formatVnd } from "../lib/format";
import { RECEIPT_STATUS_LABEL, receiptStatusClass } from "../lib/receiving";
import type { ReceiptStatus } from "../lib/receiving";
import { MethodChooserSheet } from "./parts";

const FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "Tất cả" },
  { key: "draft", label: "Đang nhập" },
  { key: "posted", label: "Đã nhập" },
  { key: "reversed", label: "Đã đảo" },
];

function fmtDate(s: string): string {
  try { return new Date(`${s}T00:00:00`).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }); }
  catch { return s; }
}

export function ReceivingList() {
  const nav = useNavigate();
  const { merchant, role } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const canManage = role === "owner" || role === "manager";

  const [receipts, setReceipts] = useState<ReceiptSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [chooserOpen, setChooserOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dupes, setDupes] = useState<DuplicateCandidate[] | null>(null);
  const debounced = useDebounced(search, 280);

  function load() {
    if (!merchantId) return;
    setLoading(true);
    api.listReceipts(merchantId, { status: filter, search: debounced.trim() || undefined })
      .then((r) => setReceipts(r.receipts))
      .catch(() => setReceipts([]))
      .finally(() => setLoading(false));
  }
  useEffect(load, [merchantId, filter, debounced]); // eslint-disable-line react-hooks/exhaustive-deps

  async function startManual() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const r = await api.createReceipt(merchantId, { receivedAt: today }, newIdempotencyKey());
      setChooserOpen(false);
      nav(`/nhap-hang/${r.receipt.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Không tạo được phiếu.");
    } finally { setBusy(false); }
  }

  async function startPhoto(file: File) {
    if (busy) return;
    setBusy(true); setError(null); setDupes(null);
    try {
      const { base64, mimeType } = await fileToBase64(file);
      const doc = await api.uploadDocument(merchantId, { image: base64, mimeType, extract: true });
      const extraction: DocumentExtraction | null = doc.extraction ?? null;
      const today = new Date().toISOString().slice(0, 10);
      const r = await api.createReceipt(merchantId, {
        documentId: doc.documentId,
        receivedAt: extraction?.receivedDate || today,
        supplierName: extraction?.supplier || null,
      }, newIdempotencyKey());
      setChooserOpen(false);
      // Hand the extraction to the editor to review + match lines (spec 3.6).
      nav(`/nhap-hang/${r.receipt.id}`, { state: { extraction } });
    } catch (e) {
      if (e instanceof ApiError && e.code === "POSSIBLE_DUPLICATE_DOCUMENT") {
        const cands = (e.details as { candidates?: DuplicateCandidate[] })?.candidates ?? [];
        setDupes(cands);
      } else {
        setError(e instanceof ApiError ? e.message : "Không đọc được chứng từ.");
      }
    } finally { setBusy(false); }
  }

  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Phiếu nhập" onBack={() => nav("/kho")} />
      <div className="content--plain catalog">
        {error && <div className="banner banner--error" style={{ marginBottom: 10 }}>{error}</div>}
        <div className="pos-search" style={{ padding: 0, marginBottom: 10 }}>
          <div className="pos-search__box"><IconSearch size={19} />
            <input className="pos-search__input" placeholder="Tìm mã phiếu hoặc nhà cung cấp…" value={search} onChange={(e) => setSearch(e.target.value)} inputMode="search" /></div>
        </div>

        <div className="seg-scroll">
          {FILTERS.map((f) => (
            <button key={f.key} className={`chip ${filter === f.key ? "chip--on" : ""}`} onClick={() => setFilter(f.key)}>{f.label}</button>
          ))}
        </div>

        {loading ? (
          <div className="muted" style={{ textAlign: "center", padding: 30 }}>Đang tải…</div>
        ) : receipts.length === 0 ? (
          <div className="empty" style={{ marginTop: 20 }}>
            <div className="empty__ic"><IconTruck size={28} /></div>
            <div className="empty__t">{search ? "Không tìm thấy phiếu" : "Chưa có phiếu nhập"}</div>
            <div className="empty__d">{search ? "Thử từ khóa khác." : "Bấm “Nhập hàng” để ghi nhận hàng đã về và tăng tồn."}</div>
          </div>
        ) : (
          <div className="stack" style={{ marginTop: 12 }}>
            {receipts.map((r) => (
              <button key={r.id} className="card card--flat inv-row" onClick={() => nav(`/nhap-hang/${r.id}`)}>
                <div className="catalog-row__main">
                  <div className="inv-row__name">{r.supplierName || "Không ghi NCC"} <span className={`pill ${receiptStatusClass(r.status as ReceiptStatus)}`}>{RECEIPT_STATUS_LABEL[r.status as ReceiptStatus]}</span></div>
                  <div className="muted tiny">{r.receiptNumber} · {fmtDate(r.receivedAt)} · {r.itemCount} mặt hàng</div>
                </div>
                <div className="inv-row__stock">
                  <span className="inv-row__qty" style={{ fontSize: 15 }}>{formatVnd(r.grandTotalVnd)}</span>
                  <IconChevron size={16} />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {canManage && (
        <button className="fab" onClick={() => setChooserOpen(true)} aria-label="Nhập hàng">
          <IconPlus size={22} /> <span>Nhập hàng</span>
        </button>
      )}

      <MethodChooserSheet open={chooserOpen} busy={busy} onClose={() => setChooserOpen(false)} onManual={startManual} onPhoto={startPhoto} />

      <Sheet open={Boolean(dupes)} onClose={() => setDupes(null)} title="Chứng từ có thể đã nhập">
        <div className="muted" style={{ marginBottom: 10 }}>Ảnh chứng từ này trùng với dữ liệu đã có. Mở phiếu liên quan để kiểm tra thay vì nhập lại.</div>
        <div className="stack">
          {(dupes ?? []).map((c) => (
            <button key={c.receiptId} className="card card--flat inv-row" onClick={() => { setDupes(null); nav(`/nhap-hang/${c.receiptId}`); }}>
              <div className="catalog-row__main"><div className="inv-row__name">{c.receiptNumber}</div><div className="muted tiny">{RECEIPT_STATUS_LABEL[c.status as ReceiptStatus] ?? c.status}</div></div>
              <div className="inv-row__stock"><span className="inv-row__qty" style={{ fontSize: 15 }}>{formatVnd(c.totalVnd)}</span></div>
            </button>
          ))}
          {(dupes ?? []).length === 0 && <div className="muted tiny">Không có phiếu liên quan — chỉ ảnh trùng. Bạn có thể nhập tay nếu chắc chắn đây là lần nhập mới.</div>}
        </div>
      </Sheet>
    </div>
  );
}
