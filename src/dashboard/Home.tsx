import { useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useMerchant } from "./MerchantContext";
import { useTodayDashboard } from "./useTodayDashboard";
import type { DashboardData } from "./useTodayDashboard";
import { LoadingScreen } from "../components/ui";
import {
  IconAlert,
  IconBox,
  IconCart,
  IconChart,
  IconChevron,
  IconReceipt,
  IconRefresh,
  IconSettings,
  IconSparkle,
  IconTax,
  IconTruck,
  IconWallet,
} from "../components/icons";
import { formatVnd, formatClockVN, formatBusinessDateVN } from "../lib/format";
import {
  cashQrSplit,
  derivePriorityItems,
  selectZeroState,
} from "../lib/dashboard";
import type { PriorityItem } from "../lib/dashboard";
import { fallbackSummary } from "../lib/summary";
import type { LowStockProduct } from "../lib/db";

function initial(name: string) {
  return (name.trim()[0] || "S").toUpperCase();
}

export function Home() {
  const nav = useNavigate();
  const { loading, merchant } = useMerchant();
  const { status, data, refreshing, offline, error, refresh } =
    useTodayDashboard(merchant?.id ?? null);

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

  const snapshot = data?.snapshot ?? null;

  return (
    <div className="screen screen--tabbed">
      <TodayHeader
        storeName={merchant.display_name}
        businessDate={snapshot?.businessDate}
        dataFreshAt={snapshot?.dataFreshAt}
        offline={offline}
        refreshing={refreshing}
        onRefresh={refresh}
      />

      <div className="content">
        {status === "loading" && !data ? (
          <DashboardSkeleton />
        ) : status === "error" && !data ? (
          <ErrorCard onRetry={refresh} message={error} />
        ) : data ? (
          <DashboardBody data={data} offline={offline} onRetry={refresh} />
        ) : null}

        <ServiceGrid />
      </div>

      <button className="today-cta" onClick={() => nav("/ban-hang")}>
        <IconCart size={22} />
        Tạo bill
      </button>
    </div>
  );
}

// ── Header ───────────────────────────────────────────────────────────────────
function TodayHeader({
  storeName,
  businessDate,
  dataFreshAt,
  offline,
  refreshing,
  onRefresh,
}: {
  storeName: string;
  businessDate?: string;
  dataFreshAt?: string;
  offline: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const dateText = businessDate ? formatBusinessDateVN(businessDate) : "Hôm nay";
  const clock = formatClockVN(dataFreshAt);
  return (
    <div className="home-head">
      <div className="home-head__row">
        <div className="avatar">{initial(storeName)}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="home-head__store">{storeName}</div>
          <div className="today-head__meta">{dateText}</div>
        </div>
        <button
          className={`iconbtn ${refreshing ? "iconbtn--spin" : ""}`}
          aria-label="Tải lại"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <IconRefresh size={19} />
        </button>
      </div>
      <div className="today-head__updated">
        {offline ? (
          <span className="today-head__offline">
            Đang hiển thị dữ liệu đã lưu{clock ? ` lúc ${clock}` : ""}
          </span>
        ) : clock ? (
          <span>Cập nhật lúc {clock}</span>
        ) : (
          <span>Đang cập nhật…</span>
        )}
      </div>
    </div>
  );
}

// ── Body ─────────────────────────────────────────────────────────────────────
function DashboardBody({
  data,
  offline,
  onRetry,
}: {
  data: DashboardData;
  offline: boolean;
  onRetry: () => void;
}) {
  const nav = useNavigate();
  const { snapshot } = data;
  const revenueState = selectZeroState(snapshot);
  const priorities = derivePriorityItems(snapshot, data.actions);
  const summary = fallbackSummary(snapshot);

  return (
    <>
      {offline && (
        <div className="banner banner--warn today-offline">
          <span>Không thể tải dữ liệu mới; đang hiển thị bản đã lưu.</span>
          <button className="today-offline__retry" onClick={onRetry}>
            Thử lại
          </button>
        </div>
      )}

      {revenueState === "fresh" ? (
        <FreshHero />
      ) : (
        <>
          <NetHero
            snapshot={snapshot}
            pending={revenueState === "pending_only"}
            onClick={() => nav("/don-hang")}
          />
          <StatPair snapshot={snapshot} />
          <CashQrCard snapshot={snapshot} />
        </>
      )}

      <AiSummaryCard headline={summary.headline} text={summary.summary} />

      {priorities.length > 0 && <AttentionSection items={priorities} />}

      {data.lowStock.length > 0 && (
        <LowStockSection products={data.lowStock} />
      )}
    </>
  );
}

function NetHero({
  snapshot,
  pending,
  onClick,
}: {
  snapshot: DashboardData["snapshot"];
  pending: boolean;
  onClick: () => void;
}) {
  const neg = snapshot.netSalesAmount < 0;
  return (
    <button className="net-hero" onClick={onClick}>
      <div className="net-hero__label">Doanh thu thuần hôm nay</div>
      {pending ? (
        <div className="net-hero__value net-hero__value--muted">
          Chưa có doanh thu được xác nhận
        </div>
      ) : (
        <div className={`net-hero__value ${neg ? "net-hero__value--neg" : ""}`}>
          {formatVnd(snapshot.netSalesAmount)}
        </div>
      )}
      <div className="net-hero__foot">
        {snapshot.refundAmount > 0 && (
          <span className="chip chip--amber">
            Đã hoàn {formatVnd(snapshot.refundAmount)}
          </span>
        )}
        <span className="chip chip--teal">
          Gộp {formatVnd(snapshot.grossSalesAmount)}
        </span>
        <span className="net-hero__link">
          Xem bill <IconChevron size={14} />
        </span>
      </div>
    </button>
  );
}

function StatPair({ snapshot }: { snapshot: DashboardData["snapshot"] }) {
  const nav = useNavigate();
  return (
    <div className="stat-pair">
      <button className="card card--flat stat-mini" onClick={() => nav("/don-hang")}>
        <div className="stat-mini__label">Bill hoàn tất</div>
        <div className="stat-mini__value">{snapshot.paidOrderCount}</div>
      </button>
      <button
        className="card card--flat stat-mini"
        onClick={() => nav("/viec-can-xu-ly")}
      >
        <div className="stat-mini__label">Cần xử lý</div>
        <div className="stat-mini__value">
          {snapshot.attentionCount}
          {snapshot.attentionCount > 0 && (
            <span className="stat-mini__dot" aria-hidden />
          )}
        </div>
      </button>
    </div>
  );
}

function CashQrCard({ snapshot }: { snapshot: DashboardData["snapshot"] }) {
  const nav = useNavigate();
  const { cashPct, qrPct } = cashQrSplit(snapshot);
  const hasSplit = cashPct + qrPct > 0;
  return (
    <button className="card card--flat cashqr" onClick={() => nav("/don-hang")}>
      <div className="cashqr__head">
        <span className="stat-card__label">Cơ cấu Tiền mặt / QR</span>
        <IconChevron size={16} color="#9aa7b4" />
      </div>
      <div className="ratio" aria-hidden>
        {hasSplit ? (
          <>
            <span className="ratio__cash" style={{ width: `${cashPct}%` }} />
            <span className="ratio__qr" style={{ width: `${qrPct}%` }} />
          </>
        ) : (
          <span className="ratio__empty" />
        )}
      </div>
      <div className="cashqr__legend">
        <div className="cashqr__item">
          <span className="cashqr__key">
            <span className="cashqr__swatch cashqr__swatch--cash" /> Tiền mặt
          </span>
          <span className="cashqr__val">{formatVnd(snapshot.cashNetAmount)}</span>
        </div>
        <div className="cashqr__item">
          <span className="cashqr__key">
            <span className="cashqr__swatch cashqr__swatch--qr" /> QR
          </span>
          <span className="cashqr__val">{formatVnd(snapshot.qrNetAmount)}</span>
        </div>
      </div>
    </button>
  );
}

function AiSummaryCard({
  headline,
  text,
}: {
  headline: string;
  text: string;
}) {
  return (
    <div className="card card--flat ai-card">
      <div className="ai-card__head">
        <span className="ai-card__badge">
          <IconSparkle size={14} />
        </span>
        <span className="ai-card__title">{headline}</span>
      </div>
      <div className="ai-card__body">{text}</div>
    </div>
  );
}

function AttentionSection({ items }: { items: PriorityItem[] }) {
  const nav = useNavigate();
  return (
    <>
      <div className="section-head">
        <div className="section-title" style={{ margin: "22px 2px 12px" }}>
          Việc cần xử lý
        </div>
        <button className="section-head__all" onClick={() => nav("/viec-can-xu-ly")}>
          Xem tất cả
        </button>
      </div>
      <div className="attn">
        {items.map((it) => (
          <AttentionRow key={it.key} item={it} onClick={() => nav(it.to)} />
        ))}
      </div>
    </>
  );
}

export function AttentionRow({
  item,
  onClick,
}: {
  item: PriorityItem;
  onClick: () => void;
}) {
  return (
    <button className="attn__row" onClick={onClick}>
      <span className={`attn__dot attn__dot--p${item.priority}`}>
        <IconAlert size={15} />
      </span>
      <span className="attn__main">
        <span className="attn__title">{item.title}</span>
        <span className="attn__desc">{item.desc}</span>
      </span>
      <IconChevron size={18} color="#9aa7b4" />
    </button>
  );
}

function LowStockSection({ products }: { products: LowStockProduct[] }) {
  const nav = useNavigate();
  return (
    <>
      <div className="section-head">
        <div className="section-title" style={{ margin: "22px 2px 12px" }}>
          Tồn kho thấp
        </div>
        <button className="section-head__all" onClick={() => nav("/ton-kho?filter=low")}>
          Xem tồn kho
        </button>
      </div>
      <div className="attn">
        {products.map((p) => (
          <button
            key={p.productId}
            className="attn__row"
            onClick={() => nav(`/ton-kho/${p.productId}`)}
          >
            <span className="attn__dot attn__dot--p3">
              <IconBox size={15} />
            </span>
            <span className="attn__main">
              <span className="attn__title">{p.name}</span>
              <span className="attn__desc">
                Còn {formatQty(p.onHand)} / ngưỡng {formatQty(p.threshold)}
              </span>
            </span>
            <IconChevron size={18} color="#9aa7b4" />
          </button>
        ))}
      </div>
    </>
  );
}

/** Inventory qty is numeric(14,3); drop a trailing ".000" for whole units. */
function formatQty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n).replace(/\.?0+$/, "");
}

// ── Zero / loading / error ───────────────────────────────────────────────────
function FreshHero() {
  return (
    <div className="net-hero net-hero--fresh">
      <div className="net-hero__label">Doanh thu thuần hôm nay</div>
      <div className="net-hero__value">{formatVnd(0)}</div>
      <div className="net-hero__fresh">
        Hôm nay chưa có giao dịch. Bấm <b>Tạo bill</b> để bắt đầu lượt bán đầu
        tiên.
      </div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="stack" aria-hidden>
      <div className="skel skel--hero" />
      <div className="stat-pair">
        <div className="skel skel--mini" />
        <div className="skel skel--mini" />
      </div>
      <div className="skel skel--card" />
    </div>
  );
}

function ErrorCard({
  onRetry,
  message,
}: {
  onRetry: () => void;
  message: string | null;
}) {
  return (
    <div className="card card--flat" style={{ textAlign: "center" }}>
      <div className="empty__ic" style={{ margin: "4px auto 14px" }}>
        <IconAlert size={26} />
      </div>
      <div className="empty__t">Không tải được dữ liệu</div>
      <div className="empty__d" style={{ marginBottom: 14 }}>
        {message ?? "Vui lòng kiểm tra kết nối và thử lại."}
      </div>
      <button className="btn btn--outline" onClick={onRetry}>
        Thử lại
      </button>
    </div>
  );
}

// ── MoMo service grid (kept below the dashboard) ─────────────────────────────
function ServiceGrid() {
  const nav = useNavigate();
  const services: { icon: ReactNode; label: string; to: string; bg: string }[] =
    [
      { icon: <IconCart size={24} />, label: "Bán hàng", to: "/ban-hang", bg: "#0d7a6f" },
      { icon: <IconReceipt size={24} />, label: "Đơn hàng", to: "/don-hang", bg: "#2f6bd4" },
      { icon: <IconBox size={24} />, label: "Kho", to: "/kho", bg: "#6b4fd0" },
      { icon: <IconTruck size={24} />, label: "Nhập hàng", to: "/nhap-hang", bg: "#b8562f" },
      { icon: <IconWallet size={24} />, label: "Chi phí", to: "/chi-phi", bg: "#c0392b" },
      { icon: <IconChart size={24} />, label: "Báo cáo", to: "/bao-cao", bg: "#1f9d6b" },
      { icon: <IconTax size={24} />, label: "Thuế", to: "/thue", bg: "#e08a1e" },
      { icon: <IconSettings size={24} />, label: "Cài đặt", to: "/cai-dat", bg: "#12314d" },
    ];
  return (
    <>
      <div className="section-title">Dịch vụ cửa hàng</div>
      <div className="grid">
        {services.map((s) => (
          <button key={s.label} className="grid__item" onClick={() => nav(s.to)}>
            <span className="grid__ic" style={{ background: s.bg }}>
              {s.icon}
            </span>
            <span className="grid__lb">{s.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}
