// "Đối chiếu tồn" (spec 6 FR-12 / 9.4) — owner-only. Lists every tracked product
// whose fast balance disagrees with the immutable ledger sum. Read-only: it raises
// awareness and links to the ledger, but never auto-fixes a number (spec 7).
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader, Banner } from "../components/ui";
import { IconShield, IconChevron } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api } from "../lib/api";
import type { ReconFinding } from "../lib/api";
import { fmtQty, fmtDelta } from "../lib/inventory";
import { unitLabel } from "../lib/catalog";

export function Reconciliation() {
  const nav = useNavigate();
  const { merchant } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const [findings, setFindings] = useState<ReconFinding[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!merchantId) return;
    setLoading(true);
    api.inventoryReconciliation(merchantId).then((r) => setFindings(r.findings)).catch(() => setFindings([])).finally(() => setLoading(false));
  }, [merchantId]);

  return (
    <div className="screen">
      <PageHeader title="Đối chiếu tồn" onBack={() => nav("/ton-kho")} />
      <div className="content--plain">
        {loading ? (
          <div className="muted" style={{ textAlign: "center", padding: 30 }}>Đang tải…</div>
        ) : findings.length === 0 ? (
          <div className="empty" style={{ marginTop: 30 }}>
            <div className="empty__ic"><IconShield size={28} /></div>
            <div className="empty__t">Sổ tồn khớp ledger</div>
            <div className="empty__d">Mọi số tồn hiện có đều bằng tổng bút toán. Không có chênh lệch.</div>
          </div>
        ) : (
          <>
            <Banner kind="warn">{findings.length} sản phẩm có tồn lệch với sổ bút toán. Hệ thống chỉ cảnh báo, không tự sửa — hãy kiểm kho hoặc điều chỉnh có lý do.</Banner>
            <div className="stack" style={{ marginTop: 12 }}>
              {findings.map((f) => (
                <button key={f.productId} className="card card--flat inv-row" onClick={() => nav(`/ton-kho/${f.productId}`)}>
                  <div className="catalog-row__main">
                    <div className="inv-row__name">{f.name}</div>
                    <div className="muted tiny">Tồn ghi nhận {fmtQty(f.balanceQty)} · Sổ bút toán {fmtQty(f.ledgerQty)} {unitLabel(f.unitCode)}</div>
                  </div>
                  <div className="inv-row__stock">
                    <span className={`inv-row__qty ${f.diff >= 0 ? "" : "inv-row__qty--out"}`}>{fmtDelta(f.diff)}</span>
                    <IconChevron size={16} />
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
