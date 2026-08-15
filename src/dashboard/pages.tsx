import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { EmptyState, PageHeader } from "../components/ui";
import {
  IconBack,
  IconBox,
  IconCart,
  IconChart,
  IconReceipt,
  IconSearch,
} from "../components/icons";

function useBack() {
  const nav = useNavigate();
  return () => nav("/");
}

// ── Bán hàng (POS skeleton) ──────────────────────────────────────────────────
export function POSPage() {
  const back = useBack();
  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Bán hàng" onBack={back} />
      <div className="content--plain">
        <div
          className="input"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            color: "#9aa7b4",
          }}
        >
          <IconSearch size={20} />
          <span>Tìm sản phẩm…</span>
        </div>

        <EmptyState
          icon={<IconCart size={30} />}
          title="Chưa có sản phẩm"
          desc="Danh mục hàng sẽ có ở bản kế tiếp. Khi đó bạn có thể thêm sản phẩm, tạo đơn và nhận tiền QR ngay tại đây."
        />
      </div>

      {/* Cart bubble (placeholder) */}
      <button
        aria-label="Giỏ hàng"
        style={{
          position: "fixed",
          right: "calc(50% - 240px + 18px)",
          bottom: "calc(var(--nav-h) + env(safe-area-inset-bottom) + 20px)",
          width: 58,
          height: 58,
          borderRadius: "50%",
          background: "var(--teal)",
          color: "#fff",
          border: "none",
          boxShadow: "0 6px 16px rgba(13,122,111,0.4)",
          display: "grid",
          placeItems: "center",
        }}
      >
        <IconCart size={24} />
      </button>
    </div>
  );
}

// ── Đơn hàng (orders list) ───────────────────────────────────────────────────
export function OrdersPage() {
  const back = useBack();
  const [period, setPeriod] = useState("today");
  const options = [
    { v: "today", l: "Hôm nay" },
    { v: "week", l: "Tuần này" },
    { v: "month", l: "Tháng này" },
  ];
  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Đơn hàng" onBack={back} />
      <div className="content--plain">
        <div className="segment">
          {options.map((o) => (
            <button
              key={o.v}
              className={`segment__btn ${
                period === o.v ? "segment__btn--on" : ""
              }`}
              onClick={() => setPeriod(o.v)}
            >
              {o.l}
            </button>
          ))}
        </div>
        <EmptyState
          icon={<IconReceipt size={30} />}
          title="Chưa có đơn hàng"
          desc="Các đơn bạn tạo sẽ hiển thị ở đây theo thời gian. Tính năng tạo đơn sẽ có ở bản kế tiếp."
        />
      </div>
    </div>
  );
}

// ── Kho (inventory) ──────────────────────────────────────────────────────────
export function InventoryPage() {
  const back = useBack();
  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Kho hàng" onBack={back} />
      <div className="content--plain">
        <EmptyState
          icon={<IconBox size={30} />}
          title="Chưa có mặt hàng trong kho"
          desc="Quản lý nhập — xuất — tồn sẽ có ở bản kế tiếp. Bạn sẽ theo dõi được số lượng và giá vốn tại đây."
        />
      </div>
    </div>
  );
}

// ── Báo cáo (reports) ────────────────────────────────────────────────────────
export function ReportsPage() {
  const back = useBack();
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
      <PageHeader title="Báo cáo" onBack={back} />
      <div className="content--plain stack">
        <div className="segment">
          {options.map((o) => (
            <button
              key={o.v}
              className={`segment__btn ${
                period === o.v ? "segment__btn--on" : ""
              }`}
              onClick={() => setPeriod(o.v)}
            >
              {o.l}
            </button>
          ))}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 12,
          }}
        >
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
            <div className="list-row__t">Chưa có dữ liệu</div>
            <div className="list-row__d">
              Số liệu sẽ hiển thị khi bạn bắt đầu tạo đơn và nhận tiền QR.
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
          <div style={{ fontWeight: 800, fontSize: 17 }}>
            Quét & tạo mã QR — sắp ra mắt
          </div>
          <div
            style={{
              opacity: 0.75,
              fontSize: 13.5,
              marginTop: 8,
              lineHeight: 1.5,
            }}
          >
            Sau khi kết nối tài khoản nhận tiền, khách sẽ quét mã để trả tiền
            trực tiếp vào cửa hàng của bạn.
          </div>
        </div>
      </div>
    </div>
  );
}
