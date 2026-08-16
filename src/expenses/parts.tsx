// Functional 07 shared UI: status badge, category chips, payment method chips,
// and the duplicate-review sheet (spec 3.7 / 4.2 — warn + candidates, human
// decides, proceed allowed). Kept dependency-light so the list, form and detail
// screens can all reuse them.
import { Sheet } from "../sales/ui";
import { Button } from "../components/ui";
import { formatVnd } from "../lib/format";
import { STATUS_LABEL, statusTone, METHOD_LABEL } from "../lib/expenses";
import type { ExpenseStatus, PaymentMethod, ExpenseCategory } from "../lib/api";

const TONE_STYLE: Record<string, React.CSSProperties> = {
  ok: { background: "#e6f6ee", color: "#0d7a4f" },
  warn: { background: "#fdf0da", color: "#a5680f" },
  danger: { background: "#fdeaea", color: "#c0392b" },
  muted: { background: "#eef1f5", color: "#5a6b7b" },
};

export function StatusBadge({ status }: { status: ExpenseStatus }) {
  const tone = statusTone(status);
  return (
    <span style={{ ...TONE_STYLE[tone], fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap" }}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Horizontally-scrolling category chips (spec 3.3 — user always confirms). */
export function CategoryChips({
  categories, value, onChange,
}: {
  categories: ExpenseCategory[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <div className="seg-scroll" style={{ paddingLeft: 0 }}>
      {categories.filter((c) => c.status === "active").map((c) => (
        <button key={c.id} className={`chip ${value === c.id ? "chip--on" : ""}`} onClick={() => onChange(c.id)}>
          {c.displayName}
        </button>
      ))}
    </div>
  );
}

const METHODS: PaymentMethod[] = ["cash", "transfer", "other"];

/** Payment method chips + a "đã xác nhận" toggle (fact only — never bank reconcile). */
export function PaymentPicker({
  method, confirmed, onMethod, onConfirmed,
}: {
  method: PaymentMethod;
  confirmed: boolean;
  onMethod: (m: PaymentMethod) => void;
  onConfirmed: (v: boolean) => void;
}) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="seg-scroll" style={{ paddingLeft: 0 }}>
        {METHODS.map((m) => (
          <button key={m} className={`chip ${method === m ? "chip--on" : ""}`} onClick={() => onMethod(m)}>
            {METHOD_LABEL[m]}
          </button>
        ))}
      </div>
      <div className="switch-row" onClick={() => onConfirmed(!confirmed)} style={{ padding: "8px 2px" }}>
        <div>
          <div className="switch-row__t">Đã có bằng chứng chi</div>
          <div className="switch-row__d">Bật nếu bạn xác nhận đã chi (biên lai/tin nhắn CK). Không tự đối soát ngân hàng.</div>
        </div>
        <span className={`switch ${confirmed ? "switch--on" : ""}`}><span className="switch__dot" /></span>
      </div>
    </div>
  );
}

export interface DuplicateCandidate { expenseId: string; expenseNumber?: string; totalVnd?: number; expenseDate?: string; payee?: string | null; }

/** The "nghi trùng" review sheet (spec 3.7 / EXP-07). Proceed is always allowed. */
export function DuplicateSheet({
  open, candidates, busy, onClose, onProceed,
}: {
  open: boolean;
  candidates: DuplicateCandidate[];
  busy: boolean;
  onClose: () => void;
  onProceed: () => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Có thể đã ghi trước đó">
      <div className="muted" style={{ marginBottom: 10 }}>
        Khoản chi này giống {candidates.length} khoản đã ghi (cùng số tiền, ngày gần nhau). Kiểm tra để tránh ghi trùng.
      </div>
      <div className="stack" style={{ marginBottom: 12 }}>
        {candidates.map((c) => (
          <div key={c.expenseId} className="card card--flat" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 600 }}>{c.payee || "Không tên"}</div>
              <div className="muted tiny">{c.expenseNumber} · {c.expenseDate}</div>
            </div>
            <div style={{ fontWeight: 700 }}>{formatVnd(c.totalVnd ?? 0)}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button className="btn btn--outline" onClick={onClose} style={{ flex: 1 }}>Kiểm tra lại</button>
        <div style={{ flex: 1 }}>
          <Button variant="primary" loading={busy} onClick={onProceed}>Vẫn ghi nhận</Button>
        </div>
      </div>
    </Sheet>
  );
}
