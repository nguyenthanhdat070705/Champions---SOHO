// "Thanh toán thành công" (spec 3.10): confirmation, receipt view/share ("Biên
// nhận", never HĐĐT), and the two exits — new bill or back to Today (which will
// reflect the paid bill via the dashboard RPC on refresh). The receipt is
// fetched with the caller's token and shown inline (no guessable public URL).
import { useState } from "react";
import { api, fetchText } from "../lib/api";
import { formatVnd } from "../lib/format";
import { IconCheck, IconReceipt, IconShare } from "../components/icons";
import { Sheet } from "./ui";

export function SuccessView({
  info, onNewBill, onHome,
}: {
  info: { orderId: string; total: number; method: string; changeDue: number };
  onNewBill: () => void;
  onHome: () => void;
}) {
  const [receiptHtml, setReceiptHtml] = useState<string | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  async function viewReceipt() {
    setReceiptOpen(true);
    if (receiptHtml) return;
    setLoading(true);
    try { setReceiptHtml(await fetchText(api.receiptUrl(info.orderId))); }
    catch { setReceiptHtml("<p style='padding:20px;font-family:sans-serif'>Không tải được biên nhận.</p>"); }
    finally { setLoading(false); }
  }

  async function share() {
    const text = `Biên nhận SoHo — ${formatVnd(info.total)} (${info.method === "cash" ? "Tiền mặt" : "QR"})`;
    try {
      if (navigator.share) await navigator.share({ title: "Biên nhận", text });
      else { await navigator.clipboard?.writeText(text); alert("Đã sao chép thông tin biên nhận."); }
    } catch { /* user cancelled */ }
  }

  return (
    <div className="screen pos-screen success">
      <div className="success__body">
        <div className="success__check"><IconCheck size={42} color="#fff" /></div>
        <div className="success__title">Thanh toán thành công</div>
        <div className="success__amount">{formatVnd(info.total)}</div>
        <div className="success__meta">{info.method === "cash" ? "Tiền mặt" : "QR ngân hàng"}</div>
        {info.method === "cash" && info.changeDue > 0 && (
          <div className="success__change">Tiền thối: <b>{formatVnd(info.changeDue)}</b></div>
        )}

        <div className="success__actions">
          <button className="btn btn--outline" onClick={viewReceipt}><IconReceipt size={18} /> Xem biên nhận</button>
          <button className="btn btn--outline" onClick={share}><IconShare size={18} /> Gửi biên nhận</button>
        </div>
      </div>

      <div className="pos-foot pos-foot--stack">
        <button className="btn btn--primary" onClick={onNewBill}>Tạo bill mới</button>
        <button className="btn btn--ghost" onClick={onHome}>Về Hôm nay</button>
      </div>

      <Sheet open={receiptOpen} onClose={() => setReceiptOpen(false)} title="Biên nhận">
        {loading ? (
          <div style={{ textAlign: "center", padding: 30 }}><div className="spinner" /></div>
        ) : (
          <iframe title="Biên nhận" className="receipt-frame" srcDoc={receiptHtml ?? ""} />
        )}
        <div className="muted tiny" style={{ textAlign: "center", marginTop: 8 }}>Biên nhận nội bộ — không phải hóa đơn điện tử (HĐĐT).</div>
      </Sheet>
    </div>
  );
}
