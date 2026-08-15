// Recent kiểm kho sessions (spec 2.1 states). Entry point to resume a counting/
// review session, review a posted one (read-only), or start a new count.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/ui";
import { IconClock, IconPlus } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api } from "../lib/api";
import type { CountSessionSummary } from "../lib/api";

const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "Nháp", cls: "pill--low" },
  counting: { label: "Đang đếm", cls: "pill--low" },
  review: { label: "Chờ duyệt", cls: "pill--inactive" },
  posted: { label: "Đã hoàn tất", cls: "pill--active" },
  cancelled: { label: "Đã hủy", cls: "pill--archived" },
};

function fmtDate(s: string | null): string {
  if (!s) return "";
  try { return new Date(s).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }); }
  catch { return s; }
}

export function CountList() {
  const nav = useNavigate();
  const { merchant, role } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const canManage = role === "owner" || role === "manager";
  const [sessions, setSessions] = useState<CountSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!merchantId) return;
    setLoading(true);
    api.countList(merchantId).then((r) => setSessions(r.sessions)).catch(() => setSessions([])).finally(() => setLoading(false));
  }, [merchantId]);

  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Kiểm kho" onBack={() => nav("/ton-kho")} />
      <div className="content--plain">
        {loading ? (
          <div className="muted" style={{ textAlign: "center", padding: 30 }}>Đang tải…</div>
        ) : sessions.length === 0 ? (
          <div className="empty" style={{ marginTop: 24 }}>
            <div className="empty__ic"><IconClock size={28} /></div>
            <div className="empty__t">Chưa có phiên kiểm kho</div>
            <div className="empty__d">Tạo phiên để đếm thực tế và ghi nhận chênh lệch có dấu vết.</div>
          </div>
        ) : (
          <div className="stack" style={{ marginTop: 12 }}>
            {sessions.map((s) => {
              const st = STATUS[s.status] ?? STATUS.counting;
              return (
                <button key={s.id} className="card card--flat inv-row" onClick={() => nav(`/ton-kho/kiem-kho/${s.id}`)}>
                  <div className="catalog-row__main">
                    <div className="inv-row__name">{s.name} <span className={`pill ${st.cls}`}>{st.label}</span></div>
                    <div className="muted tiny">{s.itemCount} mặt hàng{s.blindCount ? " · đếm mù" : ""} · {fmtDate(s.postedAt || s.startedAt)}</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {canManage && (
        <button className="fab" onClick={() => nav("/ton-kho/kiem-kho/moi")} aria-label="Tạo phiên kiểm kho">
          <IconPlus size={22} /> <span>Kiểm kho</span>
        </button>
      )}
    </div>
  );
}
