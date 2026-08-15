import { useNavigate } from "react-router-dom";
import { useMerchant } from "./MerchantContext";
import { LoadingScreen } from "../components/ui";
import {
  IconBell,
  IconBox,
  IconCart,
  IconChart,
  IconCheck,
  IconChevron,
  IconQR,
  IconReceipt,
  IconSettings,
  IconShield,
  IconSparkle,
  IconTax,
} from "../components/icons";
import { BUSINESS_MODEL_LABELS } from "../lib/enums";
import type { ReactNode } from "react";

function initial(name: string) {
  return (name.trim()[0] || "S").toUpperCase();
}

export function Home() {
  const nav = useNavigate();
  const { loading, merchant, tax, payment } = useMerchant();

  if (loading && !merchant) return <LoadingScreen />;
  if (!merchant)
    return (
      <div className="center-screen">
        <div className="empty">
          <div className="empty__t">Chưa có cửa hàng</div>
          <div className="empty__d">Vui lòng tải lại trang.</div>
        </div>
      </div>
    );

  const taxTodo =
    !tax || tax.verification_status !== "verified" ||
    tax.registration_status === "unknown";
  const qrTodo = !payment || payment.status !== "verified";

  const quick: { icon: ReactNode; label: string; to: string }[] = [
    { icon: <IconCart size={22} />, label: "Bán hàng", to: "/ban-hang" },
    { icon: <IconQR size={22} />, label: "Nhận QR", to: "/qr" },
    { icon: <IconChart size={22} />, label: "Báo cáo", to: "/bao-cao" },
    { icon: <IconTax size={22} />, label: "Thuế", to: "/thue" },
  ];

  const services: { icon: ReactNode; label: string; to: string; bg: string }[] = [
    { icon: <IconCart size={24} />, label: "Bán hàng", to: "/ban-hang", bg: "#0d7a6f" },
    { icon: <IconReceipt size={24} />, label: "Đơn hàng", to: "/don-hang", bg: "#2f6bd4" },
    { icon: <IconBox size={24} />, label: "Kho", to: "/kho", bg: "#6b4fd0" },
    { icon: <IconChart size={24} />, label: "Báo cáo", to: "/bao-cao", bg: "#1f9d6b" },
    { icon: <IconTax size={24} />, label: "Thuế", to: "/thue", bg: "#e08a1e" },
    { icon: <IconSettings size={24} />, label: "Cài đặt", to: "/cai-dat", bg: "#12314d" },
  ];

  return (
    <div className="screen screen--tabbed">
      <div className="home-head">
        <div className="home-head__row">
          <div className="avatar">{initial(merchant.display_name)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="home-head__hi">Xin chào,</div>
            <div className="home-head__store">{merchant.display_name}</div>
          </div>
          <button
            className="iconbtn"
            aria-label="Thông báo"
            onClick={() => nav("/cai-dat")}
          >
            <IconBell size={20} />
          </button>
        </div>
      </div>

      <div className="content">
        <div className="stat-card">
          <div className="stat-card__label">Doanh thu hôm nay</div>
          <div className="stat-card__value">0đ</div>
          <div className="stat-card__foot">
            <span className="chip chip--teal">
              {BUSINESS_MODEL_LABELS[merchant.business_model]}
            </span>
            <span className="chip chip--good">
              <IconSparkle size={13} /> Sẵn sàng tạo đơn đầu tiên
            </span>
          </div>
        </div>

        <div className="quick">
          {quick.map((q) => (
            <button
              key={q.label}
              className="quick__item"
              onClick={() => nav(q.to)}
            >
              <span className="quick__ic">{q.icon}</span>
              <span className="quick__lb">{q.label}</span>
            </button>
          ))}
        </div>

        <div className="section-title">Dịch vụ cửa hàng</div>
        <div className="grid">
          {services.map((s) => (
            <button
              key={s.label}
              className="grid__item"
              onClick={() => nav(s.to)}
            >
              <span className="grid__ic" style={{ background: s.bg }}>
                {s.icon}
              </span>
              <span className="grid__lb">{s.label}</span>
            </button>
          ))}
        </div>

        <div className="section-title">Việc cần làm</div>
        <div className="card card--flat" style={{ padding: "4px 16px" }}>
          <ChecklistRow
            done={!taxTodo}
            icon={<IconShield size={16} />}
            title="Xác minh thuế"
            desc={
              taxTodo
                ? "Hoàn tất thông tin thuế để SoHo hỗ trợ sổ sách."
                : "Đã xác minh."
            }
            onClick={() => nav("/thue")}
          />
          <ChecklistRow
            done={!qrTodo}
            icon={<IconQR size={16} />}
            title="Hoàn tất kết nối QR"
            desc={
              qrTodo
                ? "Kết nối tài khoản để khách quét QR trả tiền."
                : "Đã kết nối."
            }
            onClick={() => nav("/cai-dat")}
          />
        </div>
      </div>
    </div>
  );
}

function ChecklistRow({
  done,
  icon,
  title,
  desc,
  onClick,
}: {
  done: boolean;
  icon: ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <div className="checklist__row" onClick={onClick} style={{ cursor: "pointer" }}>
      <div
        className={`checklist__badge ${
          done ? "checklist__badge--done" : "checklist__badge--todo"
        }`}
      >
        {done ? <IconCheck size={16} /> : icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="list-row__t">{title}</div>
        <div className="list-row__d">{desc}</div>
      </div>
      <IconChevron size={18} color="#9aa7b4" />
    </div>
  );
}
