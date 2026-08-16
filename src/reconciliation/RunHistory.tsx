// Functional 12 — "Rule & lần chạy" (spec 3.8). A read-only list of runs with
// coverage counters (checked / new / resolved / errors). Errors surface partial
// coverage (REC-12) without exposing source payloads.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/ui";
import { IconClock } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api } from "../lib/api";
import type { ReconRun } from "../lib/api";

const RUN_STATUS_LABEL: Record<string, string> = {
  running: "Đang chạy", completed: "Hoàn tất", failed: "Lỗi",
};

export function RunHistory() {
  const nav = useNavigate();
  const { merchant } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const [runs, setRuns] = useState<ReconRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!merchantId) return;
    setLoading(true);
    api.reconRuns(merchantId, 30).then((r) => setRuns(r.runs)).catch(() => setRuns([])).finally(() => setLoading(false));
  }, [merchantId]);

  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Lịch sử đối soát" onBack={() => nav("/doi-soat")} />
      <div className="content--plain">
        {loading ? (
          <div className="muted" style={{ textAlign: "center", padding: 30 }}>Đang tải…</div>
        ) : runs.length === 0 ? (
          <div className="empty" style={{ marginTop: 20 }}>
            <div className="empty__ic"><IconClock size={26} /></div>
            <div className="empty__t">Chưa có lần chạy nào</div>
            <div className="empty__d">Chạy đối soát ở màn hình chính để bắt đầu.</div>
          </div>
        ) : (
          <div className="stack" style={{ marginTop: 6 }}>
            {runs.map((r) => {
              const c = r.counters || ({} as ReconRun["counters"]);
              const errCount = c.errors?.length ?? 0;
              return (
                <div key={r.id} className="card card--flat" style={{ padding: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 700 }}>{new Date(r.asOf).toLocaleString("vi-VN")}</span>
                    <span className="muted tiny">{RUN_STATUS_LABEL[r.status] || r.status}</span>
                  </div>
                  <div className="muted tiny" style={{ marginTop: 6, display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <span>Đã kiểm {c.checked ?? 0}</span>
                    <span>Mới {c.newIssues ?? 0}</span>
                    <span>Đã đóng {c.resolved ?? 0}</span>
                    {errCount > 0 && <span style={{ color: "#c0392b" }}>Lỗi {errCount} quy tắc</span>}
                  </div>
                  <div className="muted tiny" style={{ marginTop: 4 }}>Bộ quy tắc {r.ruleSetVersion}</div>
                  {errCount > 0 && (
                    <div className="banner banner--warn" style={{ marginTop: 8 }}>
                      Một phần dữ liệu chưa được kiểm tra — độ phủ chưa đầy đủ.
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
