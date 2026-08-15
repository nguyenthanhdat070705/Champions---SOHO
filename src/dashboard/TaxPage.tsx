import { useNavigate } from "react-router-dom";
import { useMerchant } from "./MerchantContext";
import { Banner, LoadingScreen, PageHeader } from "../components/ui";
import { IconCalendar, IconInfo, IconShield } from "../components/icons";
import {
  FILING_FREQUENCY_LABELS,
  REGISTRATION_STATUS_LABELS,
} from "../lib/enums";

const THRESHOLD = 1_000_000_000; // 1 tỷ đồng / năm

function formatVnd(n: number) {
  return n.toLocaleString("vi-VN") + "đ";
}

function quarterInfo() {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3); // 0..3
  const endOfQuarter = new Date(now.getFullYear(), q * 3 + 3, 0);
  const daysLeft = Math.max(
    0,
    Math.ceil((endOfQuarter.getTime() - now.getTime()) / 86_400_000),
  );
  return {
    label: `Quý ${q + 1}/${now.getFullYear()}`,
    daysLeft,
    endLabel: endOfQuarter.toLocaleDateString("vi-VN"),
  };
}

const VERIFY_LABELS: Record<string, string> = {
  unverified: "Chưa xác minh",
  pending: "Đang xác minh",
  verified: "Đã xác minh",
};

export function TaxPage() {
  const nav = useNavigate();
  const { loading, merchant, tax } = useMerchant();
  const revenue = 0; // no sales module yet
  const pct = Math.min(100, (revenue / THRESHOLD) * 100);
  const q = quarterInfo();

  if (loading && !merchant) return <LoadingScreen />;

  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Thuế" onBack={() => nav("/")} />
      <div className="content--plain stack">
        <div className="card">
          <div className="row-between">
            <div className="stat-card__label">Doanh thu năm nay</div>
            <span className="chip chip--teal">Ngưỡng 1 tỷ/năm</span>
          </div>
          <div className="stat-card__value" style={{ fontSize: 26 }}>
            {formatVnd(revenue)}
          </div>
          <div className="bar" style={{ marginTop: 12 }}>
            <div className="bar__fill" style={{ width: `${pct}%` }} />
          </div>
          <div
            className="row-between"
            style={{ marginTop: 8, fontSize: 12.5, color: "var(--muted)" }}
          >
            <span>0đ</span>
            <span>{formatVnd(THRESHOLD)}</span>
          </div>
          <p className="field__hint" style={{ marginTop: 10 }}>
            Đây là mốc tham khảo. SoHo chưa kết luận nghĩa vụ thuế của bạn — số
            liệu sẽ cập nhật khi bạn bắt đầu ghi nhận doanh thu.
          </p>
        </div>

        <div className="card">
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <div className="list-row__ic">
              <IconCalendar size={20} />
            </div>
            <div style={{ flex: 1 }}>
              <div className="list-row__t">Kỳ kê khai {q.label}</div>
              <div className="list-row__d">
                Còn <b>{q.daysLeft} ngày</b> đến hết kỳ ({q.endLabel})
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="section-title" style={{ margin: "2px 0 10px" }}>
            Hồ sơ thuế của cửa hàng
          </div>
          {tax ? (
            <>
              <InfoRow
                icon={<IconShield size={16} />}
                k="Tình trạng đăng ký"
                v={REGISTRATION_STATUS_LABELS[tax.registration_status]}
              />
              <InfoRow
                icon={<IconCalendar size={16} />}
                k="Kỳ kê khai"
                v={FILING_FREQUENCY_LABELS[tax.filing_frequency]}
              />
              <InfoRow
                icon={<IconInfo size={16} />}
                k="Trạng thái xác minh"
                v={VERIFY_LABELS[tax.verification_status] ?? tax.verification_status}
              />
              <InfoRow
                icon={<IconInfo size={16} />}
                k="Phiên bản áp dụng"
                v={tax.config_version}
              />
            </>
          ) : (
            <p className="muted">Chưa có hồ sơ thuế.</p>
          )}
        </div>

        <Banner kind="info">
          Bạn có thể cập nhật tình trạng thuế bất cứ lúc nào trong mục Cài đặt.
          SoHo sẽ hướng dẫn khi có thêm dữ liệu.
        </Banner>
      </div>
    </div>
  );
}

function InfoRow({
  icon,
  k,
  v,
}: {
  icon: React.ReactNode;
  k: string;
  v: string;
}) {
  return (
    <div className="checklist__row">
      <div className="checklist__badge checklist__badge--done" style={{ background: "var(--navy-050)", color: "var(--navy)" }}>
        {icon}
      </div>
      <div style={{ flex: 1 }}>
        <div className="list-row__d">{k}</div>
        <div className="list-row__t">{v}</div>
      </div>
    </div>
  );
}
