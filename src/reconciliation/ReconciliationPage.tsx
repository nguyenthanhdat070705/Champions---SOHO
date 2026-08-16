// Functional 12 — "Trung tâm đối soát" + "Danh sách sai lệch" (spec 3.1 / 3.2).
// One mobile screen: a data-cleanliness hero + a "Chạy đối soát" CTA, family
// cards, impact/status filters and the issue queue. No red badges app-wide, no
// bulk resolve (spec 3.1/3.2 rules). Owner/manager run; any member views.
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/ui";
import { IconShield, IconChevron, IconClock, IconRefresh, IconCheck } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api, newIdempotencyKey } from "../lib/api";
import type { ReconSummary, ReconIssue, ReconImpact } from "../lib/api";
import {
  FAMILY_LABEL, FAMILY_DESC, CENTER_FAMILIES, IMPACT_LABEL, IMPACT_ORDER,
} from "../lib/reconciliation";
import { ImpactBadge, StatusBadge } from "./parts";

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "chưa chạy";
  const then = new Date(iso).getTime();
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "vừa xong";
  if (mins < 60) return `${mins} phút trước`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} giờ trước`;
  return `${Math.floor(hrs / 24)} ngày trước`;
}

const STATUS_FILTERS = [
  { key: "active", label: "Đang mở" },
  { key: "resolved", label: "Đã xử lý" },
  { key: "dismissed", label: "Đã bỏ qua" },
  { key: "all", label: "Tất cả" },
];

export function ReconciliationPage() {
  const nav = useNavigate();
  const { merchant, role } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const canRun = role === "owner" || role === "manager";

  const [summary, setSummary] = useState<ReconSummary | null>(null);
  const [issues, setIssues] = useState<ReconIssue[]>([]);
  const [status, setStatus] = useState("active");
  const [impact, setImpact] = useState<ReconImpact | "">("");
  const [family, setFamily] = useState("");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadIssues = useCallback(() => {
    if (!merchantId) return;
    setLoading(true);
    api.reconIssues(merchantId, { status, impact: impact || undefined, family: family || undefined })
      .then((r) => setIssues(r.issues))
      .catch(() => setIssues([]))
      .finally(() => setLoading(false));
  }, [merchantId, status, impact, family]);

  const loadSummary = useCallback(() => {
    if (!merchantId) return;
    api.reconSummary(merchantId).then(setSummary).catch(() => setSummary(null));
  }, [merchantId]);

  useEffect(() => { loadSummary(); }, [loadSummary]);
  useEffect(() => { loadIssues(); }, [loadIssues]);

  async function runNow() {
    if (!merchantId || running) return;
    setRunning(true); setRunMsg(null); setError(null);
    try {
      const { run } = await api.reconRun(merchantId, {}, newIdempotencyKey());
      const c = run.counters;
      setRunMsg(`Đã kiểm tra ${c.checked} mục · ${c.newIssues} sai lệch mới · ${c.resolved} đã tự đóng`);
      loadSummary();
      loadIssues();
    } catch (e) {
      setError((e as Error).message || "Không chạy được đối soát.");
    } finally {
      setRunning(false);
    }
  }

  const activeTotal = summary?.active.total ?? 0;
  const lastRun = summary?.lastRun;

  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Đối soát" onBack={() => nav("/")} />
      <div className="content--plain catalog">
        {/* Hero: data cleanliness (spec 3.1) */}
        <div className="card" style={{ padding: "16px 14px", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 40, height: 40, borderRadius: 12, background: "#12314d", color: "#fff", display: "grid", placeItems: "center", flex: "0 0 auto" }}>
              <IconShield size={22} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="muted tiny">Sai lệch đang mở</div>
              <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.1 }}>{activeTotal}</div>
            </div>
            <button className="chip" onClick={() => nav("/doi-soat/lich-su")} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <IconClock size={13} /> Lịch sử
            </button>
          </div>
          <div className="muted tiny" style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
            <IconClock size={12} />
            Mốc kiểm tra: {timeAgo(lastRun?.asOf)}
            {lastRun ? ` · đã kiểm ${lastRun.counters?.checked ?? 0} mục` : ""}
          </div>
          {canRun && (
            <button className="btn btn--primary" style={{ width: "100%", marginTop: 12 }} onClick={runNow} disabled={running}>
              <IconRefresh size={17} /> {running ? "Đang chạy…" : "Chạy đối soát"}
            </button>
          )}
        </div>

        {runMsg && (
          <div className="banner" style={{ marginBottom: 12, background: "#e6f6ee", color: "#0d7a4f", display: "flex", gap: 6, alignItems: "center" }}>
            <IconCheck size={15} /> {runMsg}
          </div>
        )}
        {error && <div className="banner banner--warn" style={{ marginBottom: 12 }}>{error}</div>}

        {/* Family cards (spec 3.1) */}
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
          {CENTER_FAMILIES.map((f) => {
            const count = summary?.active.byFamily[f] ?? 0;
            const on = family === f;
            return (
              <button key={f} className="card card--flat" onClick={() => setFamily(on ? "" : f)}
                style={{ textAlign: "left", padding: 12, border: on ? "1.5px solid #12314d" : undefined }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>{FAMILY_LABEL[f]}</span>
                  <span style={{ fontWeight: 800, fontSize: 18, color: count ? "#c0392b" : "#8a97a5" }}>{count}</span>
                </div>
                <div className="muted tiny" style={{ marginTop: 3 }}>{FAMILY_DESC[f]}</div>
              </button>
            );
          })}
        </div>

        {/* Filters */}
        <div className="seg-scroll" style={{ marginBottom: 8 }}>
          {STATUS_FILTERS.map((f) => (
            <button key={f.key} className={`chip ${status === f.key ? "chip--on" : ""}`} onClick={() => setStatus(f.key)}>{f.label}</button>
          ))}
        </div>
        <div className="seg-scroll" style={{ marginBottom: 10 }}>
          <button className={`chip ${impact === "" ? "chip--on" : ""}`} onClick={() => setImpact("")}>Mọi mức</button>
          {IMPACT_ORDER.map((im) => (
            <button key={im} className={`chip ${impact === im ? "chip--on" : ""}`} onClick={() => setImpact(im)}>{IMPACT_LABEL[im]}</button>
          ))}
          {family && (
            <button className="chip chip--on" onClick={() => setFamily("")}>✕ {FAMILY_LABEL[family as keyof typeof FAMILY_LABEL]}</button>
          )}
        </div>

        {/* Queue */}
        {loading ? (
          <div className="muted" style={{ textAlign: "center", padding: 30 }}>Đang tải…</div>
        ) : issues.length === 0 ? (
          <div className="empty" style={{ marginTop: 20 }}>
            <div className="empty__ic"><IconShield size={28} /></div>
            <div className="empty__t">{status === "active" ? "Không có sai lệch đang mở" : "Không có mục nào"}</div>
            <div className="empty__d">
              {status === "active"
                ? "Dữ liệu bill – thu – tồn – chứng từ đang khớp. Bấm “Chạy đối soát” để kiểm tra lại."
                : "Thử bộ lọc khác."}
            </div>
          </div>
        ) : (
          <div className="stack" style={{ marginTop: 4 }}>
            {issues.map((it) => (
              <button key={it.id} className="card card--flat" onClick={() => nav(`/doi-soat/${it.id}`)}
                style={{ display: "flex", gap: 10, alignItems: "flex-start", width: "100%", textAlign: "left" }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 700 }}>{it.title}</span>
                    <ImpactBadge impact={it.impact} />
                    {it.status !== "detected" && <StatusBadge status={it.status} />}
                  </div>
                  {it.summary && <div className="muted tiny" style={{ marginTop: 4 }}>{it.summary}</div>}
                  <div className="muted tiny" style={{ marginTop: 4 }}>{timeAgo(it.detectedAt)}</div>
                </div>
                <IconChevron size={18} color="#9aa7b4" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
