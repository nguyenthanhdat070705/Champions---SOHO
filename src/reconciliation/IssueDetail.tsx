// Functional 12 — "Chi tiết sai lệch & bằng chứng" + guided resolution (spec 3.3
// / 3.5 / 3.6). Shows the rule explanation, the immutable evidence snapshot vs the
// live source (with a stale banner), the decision history, and the allowed actions:
// open the source record (guided fix in the owning flow), hand off (records an
// intent → action_pending), or dismiss with a reason. F12 never mutates source
// data; the mismatch is verified-closed on the next run.
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader, LoadingScreen } from "../components/ui";
import { IconChevron, IconShare, IconCheck } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import type { ReconIssueDetail } from "../lib/api";
import { STATUS_LABEL, isActiveStatus } from "../lib/reconciliation";
import { ImpactBadge, StatusBadge, EvidenceCard, LiveBanner, DismissSheet } from "./parts";

export function IssueDetail() {
  const nav = useNavigate();
  const { issueId = "" } = useParams();
  const { merchant, role } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const canRun = role === "owner" || role === "manager";

  const [data, setData] = useState<ReconIssueDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [dismissOpen, setDismissOpen] = useState(false);

  const load = useCallback(() => {
    if (!merchantId || !issueId) return;
    setLoading(true);
    api.reconIssue(merchantId, issueId)
      .then(setData)
      .catch((e) => setNote((e as Error).message))
      .finally(() => setLoading(false));
  }, [merchantId, issueId]);

  useEffect(load, [load]);

  async function withGuard(fn: () => Promise<ReconIssueDetail>, ok: string) {
    if (busy) return;
    setBusy(true); setNote(null);
    try {
      const next = await fn();
      setData(next);
      setNote(ok);
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        setNote("Sai lệch vừa thay đổi ở nơi khác; đã tải lại.");
        load();
      } else {
        setNote((e as Error).message || "Không thực hiện được.");
      }
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <LoadingScreen />;
  if (!data) {
    return (
      <div className="screen">
        <PageHeader title="Sai lệch" onBack={() => nav("/doi-soat")} />
        <div className="content--plain"><div className="empty" style={{ marginTop: 30 }}>
          <div className="empty__t">Không tải được</div>
          <div className="empty__d">{note || "Vui lòng thử lại."}</div>
        </div></div>
      </div>
    );
  }

  const { issue, ruleExplain, evidence, attempts, live, actions } = data;
  const active = isActiveStatus(issue.status);
  const latest = evidence.length ? evidence[evidence.length - 1] : null;
  const handoff = actions.find((a) => a.kind === "handoff");

  return (
    <div className="screen">
      <PageHeader title="Chi tiết sai lệch" onBack={() => nav("/doi-soat")} />
      <div className="content--plain" style={{ paddingBottom: 96 }}>
        {/* Rule callout (spec 3.3) */}
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
            <span style={{ fontWeight: 800, fontSize: 16 }}>{issue.title}</span>
            <ImpactBadge impact={issue.impact} />
            <StatusBadge status={issue.status} />
          </div>
          {ruleExplain && <div style={{ fontSize: 14, lineHeight: 1.5 }}>{ruleExplain}</div>}
          <div className="muted tiny" style={{ marginTop: 8 }}>Quy tắc: {issue.ruleId} · {issue.ruleVersion}</div>
        </div>

        <LiveBanner live={live} />

        {note && (
          <div className="banner" style={{ margin: "10px 0", background: "#eef2f7", color: "#2b3a49", display: "flex", gap: 6, alignItems: "center" }}>
            <IconCheck size={15} /> {note}
          </div>
        )}

        {/* Evidence: snapshot at detect + (if still mismatched) the live source (spec 3.3 A/B) */}
        <div className="section-title" style={{ margin: "16px 2px 8px" }}>Bằng chứng</div>
        <div className="stack" style={{ gap: 10 }}>
          {latest && <EvidenceCard ev={latest} title="Lúc phát hiện (đã khóa)" tone="amber" />}
          {live.status === "still_mismatched" && live.facts && (
            <EvidenceCard
              ev={{ ...latest!, facts: live.facts, sourceVersion: latest?.sourceVersion ?? 1, asOf: new Date().toISOString() }}
              title="Hiện tại (nguồn trực tiếp)" tone="blue" />
          )}
          {evidence.length > 1 && (
            <div className="muted tiny">{evidence.length} ảnh chụp bằng chứng qua các lần chạy (không thể sửa).</div>
          )}
        </div>

        {/* Open the owning record (guided fix) */}
        {issue.deepLink && (
          <button className="card card--flat" onClick={() => nav(issue.deepLink!.route)}
            style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", marginTop: 12 }}>
            <span style={{ width: 34, height: 34, borderRadius: 10, background: "#e7eefb", color: "#2f5fd0", display: "grid", placeItems: "center" }}>
              <IconShare size={17} />
            </span>
            <span style={{ flex: 1 }}>
              <span style={{ fontWeight: 700, display: "block" }}>Mở bản ghi gốc</span>
              <span className="muted tiny">{issue.actionHint || "Xem và sửa ở luồng chuẩn"}</span>
            </span>
            <IconChevron size={18} color="#9aa7b4" />
          </button>
        )}

        {/* Decision history (spec 3.7) */}
        {attempts.length > 0 && (
          <>
            <div className="section-title" style={{ margin: "18px 2px 8px" }}>Lịch sử xử lý</div>
            <div className="stack" style={{ gap: 8 }}>
              {attempts.map((a) => (
                <div key={a.id} className="card card--flat" style={{ padding: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{a.actionType}</span>
                    <span className="muted tiny">{a.status}</span>
                  </div>
                  {a.reason && (a.reason as { code?: string; note?: string }).note && (
                    <div className="muted tiny" style={{ marginTop: 3 }}>{(a.reason as { note?: string }).note}</div>
                  )}
                  <div className="muted tiny" style={{ marginTop: 3 }}>{new Date(a.createdAt).toLocaleString("vi-VN")}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Resolution actions (spec 3.5) — owner/manager only; server also enforces */}
        {active && canRun && (
          <>
            <div className="section-title" style={{ margin: "18px 2px 8px" }}>Cách xử lý</div>
            <div className="stack" style={{ gap: 8 }}>
              {issue.status === "detected" && (
                <button className="btn btn--outline" disabled={busy}
                  onClick={() => withGuard(() => api.reconReview(merchantId, issueId, issue.rowVersion), "Đã đánh dấu đang xem.")}>
                  Đánh dấu đang xem
                </button>
              )}
              {handoff && (
                <button className="btn btn--navy" disabled={busy}
                  onClick={() => withGuard(
                    () => api.reconAction(merchantId, issueId, {
                      actionType: handoff.type, intentId: newIdempotencyKey(),
                      reason: { code: "HANDOFF" }, expectedVersion: issue.rowVersion,
                    }),
                    "Đã ghi nhận chuyển xử lý. Mở bản ghi gốc để sửa; chạy đối soát lại để đóng mục này.")}>
                  {handoff.label}
                </button>
              )}
              <button className="btn btn--ghost" disabled={busy} onClick={() => setDismissOpen(true)}>
                Bỏ qua (có lý do)
              </button>
            </div>
          </>
        )}
        {!active && (
          <div className="muted tiny" style={{ textAlign: "center", marginTop: 18 }}>
            Mục này đã ở trạng thái “{STATUS_LABEL[issue.status]}”.
          </div>
        )}
      </div>

      <DismissSheet open={dismissOpen} onClose={() => setDismissOpen(false)} busy={busy}
        onConfirm={(reasonCode, dismissNote) =>
          withGuard(
            () => api.reconIgnore(merchantId, issueId, { reasonCode, note: dismissNote, intentId: newIdempotencyKey(), expectedVersion: issue.rowVersion }),
            "Đã bỏ qua sai lệch.",
          ).then(() => setDismissOpen(false))} />
    </div>
  );
}
