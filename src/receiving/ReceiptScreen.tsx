// Route wrapper for /nhap-hang/:id — loads the receipt then renders the editor
// (draft/review/ready) or the read-only detail (posted/reversed/cancelled). Keeps
// the "sau post, Back mở detail read-only, không về form editable" rule (spec 2.2).
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../components/ui";
import { InlineError } from "../sales/ui";
import { useMerchant } from "../dashboard/MerchantContext";
import { api } from "../lib/api";
import type { ReceiptDetail as ReceiptDetailData } from "../lib/api";
import { isEditable } from "../lib/receiving";
import type { ReceiptStatus } from "../lib/receiving";
import { ReceiptEditor } from "./ReceiptEditor";
import { ReceiptDetail } from "./ReceiptDetail";

export function ReceiptScreen() {
  const nav = useNavigate();
  const { id } = useParams();
  const { merchant } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const [data, setData] = useState<ReceiptDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!merchantId || !id) return;
    setLoading(true);
    api.getReceipt(merchantId, id)
      .then(setData)
      .catch(() => setError("Không tải được phiếu nhập."))
      .finally(() => setLoading(false));
  }, [merchantId, id]);
  useEffect(load, [load]);

  if (loading) {
    return <div className="screen"><PageHeader title="Phiếu nhập" onBack={() => nav("/nhap-hang")} /><div className="muted" style={{ textAlign: "center", padding: 40 }}>Đang tải…</div></div>;
  }
  if (!data) {
    return <div className="screen"><PageHeader title="Phiếu nhập" onBack={() => nav("/nhap-hang")} /><InlineError message={error ?? "Không tìm thấy."} /></div>;
  }

  if (isEditable(data.receipt.status as ReceiptStatus)) {
    return <ReceiptEditor receipt={data.receipt} items={data.items} reload={load} onPosted={load} />;
  }
  return <ReceiptDetail data={data} reload={load} />;
}
