// "Chọn phương thức thanh toán" (spec 3.7): the locked bill total plus two big
// method cards. Cash and QR each open their own screen; the total shown is the
// server-locked order total, never a local sum.
import { formatVnd } from "../lib/format";
import { IconBack, IconQR, IconWallet } from "../components/icons";

export function PaymentMethod({
  total, onBack, onCash, onQr,
}: {
  total: number;
  onBack: () => void;
  onCash: () => void;
  onQr: () => void;
}) {
  return (
    <div className="screen pos-screen">
      <div className="pos-top">
        <button className="step__back" onClick={onBack} aria-label="Quay lại"><IconBack size={20} /></button>
        <div className="pos-top__title">Thanh toán</div>
        <span style={{ width: 40 }} />
      </div>

      <div className="pos-scroll">
        <div className="pay-total card">
          <div className="pay-total__label">Tổng cần thanh toán</div>
          <div className="pay-total__value">{formatVnd(total)}</div>
        </div>

        <button className="pay-method" onClick={onCash}>
          <span className="pay-method__ic pay-method__ic--cash"><IconWallet size={26} /></span>
          <span className="pay-method__body">
            <span className="pay-method__t">Tiền mặt</span>
            <span className="pay-method__d">Nhận tiền và tính tiền thối</span>
          </span>
        </button>

        <button className="pay-method" onClick={onQr}>
          <span className="pay-method__ic pay-method__ic--qr"><IconQR size={26} /></span>
          <span className="pay-method__body">
            <span className="pay-method__t">QR ngân hàng</span>
            <span className="pay-method__d">Khách quét mã, xác nhận tự động</span>
          </span>
        </button>

        <div className="muted tiny" style={{ textAlign: "center", marginTop: 18, lineHeight: 1.5 }}>
          SoHo không hỗ trợ bán nợ. Chỉ khi tiền mặt được xác nhận hoặc QR có xác nhận hợp lệ thì bill mới hoàn tất.
        </div>
      </div>
    </div>
  );
}
