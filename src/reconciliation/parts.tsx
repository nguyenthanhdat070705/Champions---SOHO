// Functional 12 shared UI: impact/status badges, the evidence comparison card,
// and the dismiss-reason sheet. Dependency-light so the centre, queue and detail
// screens reuse them. Badges are self-contained (inline colours) like F07's.
import { useState } from "react";
import { Sheet } from "../sales/ui";
import { Button } from "../components/ui";
import type { ReconImpact, ReconIssueStatus, ReconEvidence, ReconLive } from "../lib/api";
import {
  IMPACT_LABEL, IMPACT_TONE, STATUS_LABEL, STATUS_TONE, IGNORE_REASONS, renderFacts,
} from "../lib/reconciliation";

const TONE_STYLE: Record<string, React.CSSProperties> = {
  red: { background: "#fdeaea", color: "#c0392b" },
  amber: { background: "#fdf0da", color: "#a5680f" },
  teal: { background: "#e3f4f1", color: "#0d7a6f" },
  blue: { background: "#e7eefb", color: "#2f5fd0" },
  green: { background: "#e6f6ee", color: "#0d7a4f" },
  muted: { background: "#eef1f5", color: "#5a6b7b" },
};

function Badge({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span style={{ ...TONE_STYLE[tone] || TONE_STYLE.muted, fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

export function ImpactBadge({ impact }: { impact: ReconImpact }) {
  return <Badge tone={IMPACT_TONE[impact]}>{IMPACT_LABEL[impact]}</Badge>;
}
export function StatusBadge({ status }: { status: ReconIssueStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

/** A single evidence snapshot rendered as a labelled facts table (spec 3.3 Bên A/B). */
export function EvidenceCard({
  ev, title, tone,
}: {
  ev: ReconEvidence;
  title: string;
  tone?: string;
}) {
  const rows = renderFacts(ev.facts);
  return (
    <div className="card card--flat" style={{ padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{title}</span>
        <Badge tone={tone || "muted"}>{ev.sourceType} · v{ev.sourceVersion}</Badge>
      </div>
      <div className="stack" style={{ gap: 4 }}>
        {rows.map((r) => (
          <div key={r.key} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
            <span className="muted">{r.label}</span>
            <span style={{ fontWeight: 600, textAlign: "right" }}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Live-source banner: warns when the source moved since the snapshot (spec 3.3 / REC-04). */
export function LiveBanner({ live }: { live: ReconLive }) {
  if (live.status === "cleared") {
    return (
      <div className="banner" style={{ marginTop: 10, background: "#e6f6ee", color: "#0d7a4f" }}>
        Nguồn đã được sửa — sai lệch không còn. Chạy đối soát lại để đóng mục này.
      </div>
    );
  }
  if (live.status === "still_mismatched" && live.changed) {
    return (
      <div className="banner banner--warn" style={{ marginTop: 10 }}>
        Nguồn vừa thay đổi so với lúc phát hiện; hãy xem lại bằng chứng hiện tại trước khi xử lý.
      </div>
    );
  }
  if (live.status === "still_mismatched") {
    return (
      <div className="banner" style={{ marginTop: 10 }}>
        Sai lệch vẫn còn theo dữ liệu hiện tại.
      </div>
    );
  }
  return null;
}

/** Bottom sheet to dismiss an issue with a required reason (spec 4.2 / REC-10). */
export function DismissSheet({
  open, onClose, onConfirm, busy,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (reasonCode: string, note: string) => void;
  busy: boolean;
}) {
  const [code, setCode] = useState(IGNORE_REASONS[0].code);
  const [note, setNote] = useState("");
  const needsNote = IGNORE_REASONS.find((r) => r.code === code)?.needsNote;
  const blocked = busy || (needsNote && !note.trim());
  return (
    <Sheet open={open} onClose={onClose} title="Bỏ qua sai lệch">
      <div className="stack" style={{ gap: 10 }}>
        <div className="muted tiny">Chọn lý do — mục này sẽ được đánh dấu đã bỏ qua và không hiện lại.</div>
        <div className="seg-scroll" style={{ paddingLeft: 0, flexWrap: "wrap", display: "flex", gap: 6 }}>
          {IGNORE_REASONS.map((r) => (
            <button key={r.code} className={`chip ${code === r.code ? "chip--on" : ""}`} onClick={() => setCode(r.code)}>
              {r.label}
            </button>
          ))}
        </div>
        {needsNote && (
          <textarea className="input" placeholder="Nhập lý do…" value={note} onChange={(e) => setNote(e.target.value)}
            rows={3} style={{ width: "100%", resize: "vertical" }} />
        )}
        <Button variant="primary" disabled={blocked} onClick={() => onConfirm(code, note.trim())}>
          {busy ? "Đang lưu…" : "Xác nhận bỏ qua"}
        </Button>
      </div>
    </Sheet>
  );
}
