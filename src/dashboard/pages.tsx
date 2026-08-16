import { useNavigate } from "react-router-dom";
import { IconBack } from "../components/icons";

// The POS (Bán hàng → src/sales), Orders (Đơn hàng → src/orders), Inventory
// (Kho → src/inventory) and Reports (Báo cáo → src/reports) screens are now real,
// routed elsewhere in App.tsx. This file keeps the QR scanner placeholder.

// ── QR placeholder (scan-like, immersive) ───────────────────────────────────
export function QRScreen() {
  const nav = useNavigate();
  return (
    <div className="qr-screen">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "calc(env(safe-area-inset-top) + 14px) 16px 8px",
        }}
      >
        <button
          className="step__back"
          style={{ background: "rgba(255,255,255,0.15)", color: "#fff" }}
          onClick={() => nav("/")}
          aria-label="Quay lại"
        >
          <IconBack size={20} />
        </button>
        <div style={{ fontWeight: 800, fontSize: 18 }}>Quét mã QR</div>
      </div>

      <div className="qr-frame">
        <div className="qr-box">
          <span className="qr-corner qr-corner--tl" />
          <span className="qr-corner qr-corner--tr" />
          <span className="qr-corner qr-corner--bl" />
          <span className="qr-corner qr-corner--br" />
        </div>
        <div style={{ textAlign: "center", maxWidth: 280 }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>Tạo bill để nhận QR</div>
          <div style={{ opacity: 0.75, fontSize: 13.5, marginTop: 8, lineHeight: 1.5 }}>
            Mã QR động cho từng bill được tạo trong luồng bán hàng. Bấm “Tạo
            bill” ở Trang chủ để bắt đầu.
          </div>
        </div>
      </div>
    </div>
  );
}
