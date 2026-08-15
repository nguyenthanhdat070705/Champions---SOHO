import { useLocation, useNavigate } from "react-router-dom";
import { IconHome, IconQR, IconSettings, IconRobot } from "../components/icons";

export function BottomNav() {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const isHome = pathname === "/";
  const isAssistant = pathname === "/tro-ly";
  const isSettings = pathname === "/cai-dat";

  return (
    <nav className="bottomnav">
      <button
        className={`bottomnav__item ${isHome ? "bottomnav__item--on" : ""}`}
        onClick={() => nav("/")}
      >
        <IconHome size={22} />
        <span>Trang chủ</span>
      </button>

      <button
        className={`bottomnav__item ${isAssistant ? "bottomnav__item--on" : ""}`}
        onClick={() => nav("/tro-ly")}
      >
        <IconRobot size={22} />
        <span>Trợ lý</span>
      </button>

      <div className="bottomnav__center">
        <button
          className="bottomnav__qr"
          onClick={() => nav("/qr")}
          aria-label="Mã QR"
        >
          <IconQR size={26} />
        </button>
        <span className="bottomnav__qrlb">QR</span>
      </div>

      <button
        className={`bottomnav__item ${isSettings ? "bottomnav__item--on" : ""}`}
        onClick={() => nav("/cai-dat")}
      >
        <IconSettings size={22} />
        <span>Cài đặt</span>
      </button>
    </nav>
  );
}
