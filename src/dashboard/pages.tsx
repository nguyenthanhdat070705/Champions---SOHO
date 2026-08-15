import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/ui";
import { IconBack, IconChart } from "../components/icons";

// The POS (Bán hàng → src/sales), Orders (Đơn hàng → src/orders) and Inventory
// (Kho → src/inventory) screens are now real, routed elsewhere in App.tsx. This
// file keeps the remaining not-yet-built placeholders (Reports, the QR scanner).

// ── Báo cáo (reports placeholder) ────────────────────────────────────────────
export function ReportsPage() {
  const nav = useNavigate();
  const [period, setPeriod] = useState("day");
  const options = [
    { v: "day", l: "Ngày" },
    { v: "month", l: "Tháng" },
    { v: "quarter", l: "Quý" },
    { v: "year", l: "Năm" },
  ];
  const stats = [
    { k: "Doanh thu", v: "0đ" },
    { k: "Số đơn", v: "0" },
    { k: "Trung bình/đơn", v: "0đ" },
    { k: "Tiền mặt / QR", v: "0đ / 0đ" },
  ];
  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Báo cáo" onBack={() => nav("/")} />
      <div className="content--plain stack">
        <div className="segment">
          {options.map((o) => (
            <button
              key={o.v}
              className={`segment__btn ${period === o.v ? "segment__btn--on" : ""}`}
              onClick={() => setPeriod(o.v)}
            >
              {o.l}
            </button>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {stats.map((s) => (
            <div className="card card--flat" key={s.k}>
              <div className="stat-card__label">{s.k}</div>
              <div className="stat-card__value" style={{ fontSize: 22 }}>
                {s.v}
              </div>
            </div>
          ))}
        </div>

        <div className="card" style={{ display: "flex", gap: 12 }}>
          <div className="list-row__ic">
            <IconChart size={20} />
          </div>
          <div style={{ flex: 1 }}>
            <div className="list-row__t">Báo cáo chuyên sâu sắp ra mắt</div>
            <div className="list-row__d">
              Doanh thu ngày đã có ở Trang Hôm nay và Đơn hàng. Báo cáo theo kỳ
              sẽ được bổ sung ở bản kế tiếp.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

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
