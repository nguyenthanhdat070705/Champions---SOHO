// Functional 13 — Báo cáo screen building blocks: coverage chip, metric card,
// CSS bar list, drill-down sheet and compare sheet. Kept presentational; the page
// owns data fetching. Numbers never fabricate a 0 for missing data (spec 4.4).
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Sheet } from "../sales/ui";
import { IconChevron } from "../components/icons";
import { formatVnd } from "../lib/format";
import { coverageMeta, barPct, formatQty, pctText, formatDelta } from "../lib/reports";
import { api } from "../lib/api";
import type { Coverage, ReportDrilldown, ReportListItem, ReportCompare } from "../lib/api";

export function CoverageChip({ status }: { status: Coverage }) {
  const m = coverageMeta(status);
  const cls = m.tone === "good" ? "chip--good" : m.tone === "amber" ? "chip--amber" : "";
  return <span className={`chip ${cls}`} style={{ fontSize: 12 }}>{m.label}</span>;
}

export function MetricCard({
  label, value, sub, tone, coverage, onClick,
}: {
  label: string; value: string; sub?: string; tone?: "navy" | "plain";
  coverage?: Coverage; onClick?: () => void;
}) {
  return (
    <button
      className="card card--flat"
      onClick={onClick}
      disabled={!onClick}
      style={{ textAlign: "left", display: "flex", flexDirection: "column", gap: 4, cursor: onClick ? "pointer" : "default", border: "none" }}
    >
      <div className="stat-card__label" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span>{label}</span>
        {coverage && coverage !== "complete" && <CoverageChip status={coverage} />}
      </div>
      <div className="stat-card__value" style={{ fontSize: 22, color: tone === "navy" ? "var(--navy-700, #1f3a5f)" : undefined }}>{value}</div>
      {sub && <div className="list-row__d" style={{ fontSize: 12 }}>{sub}</div>}
    </button>
  );
}

/** A horizontal CSS bar list (spec: đơn giản charts, no decorative library). */
export function BarList({ rows, unit = "vnd" }: { rows: { label: string; value: number; sub?: string; onClick?: () => void }[]; unit?: "vnd" | "count" }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  if (rows.length === 0) return <div className="list-row__d">Chưa có dữ liệu.</div>;
  return (
    <div className="stack" style={{ gap: 10 }}>
      {rows.map((r, i) => (
        <button key={i} onClick={r.onClick} disabled={!r.onClick} style={{ background: "none", border: "none", padding: 0, textAlign: "left", cursor: r.onClick ? "pointer" : "default" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
            <span className="list-row__t" style={{ fontSize: 14 }}>{r.label}</span>
            <span className="list-row__v" style={{ fontSize: 14, fontWeight: 600 }}>{unit === "vnd" ? formatVnd(r.value) : formatQty(r.value)}</span>
          </div>
          <div className="bar"><div className="bar__fill" style={{ width: `${barPct(r.value, max)}%` }} /></div>
          {r.sub && <div className="list-row__d" style={{ fontSize: 12, marginTop: 2 }}>{r.sub}</div>}
        </button>
      ))}
    </div>
  );
}

export function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="card stack" style={{ gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="list-row__t" style={{ fontWeight: 700 }}>{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}

// ── Drill-down sheet: source records behind a metric (spec 3.x / RPT-06/10) ────
export function DrilldownSheet({
  merchantId, snapshotId, metric, title, params, onClose,
}: {
  merchantId: string; snapshotId: string; metric: string; title: string;
  params?: { date?: string; channel?: string; categoryId?: string; productId?: string };
  onClose: () => void;
}) {
  const nav = useNavigate();
  const [data, setData] = useState<ReportDrilldown | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null); setErr(null);
    api.reportDrilldown(merchantId, snapshotId, { metric, ...params })
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setErr(e.message || "Không tải được danh sách nguồn."); });
    return () => { live = false; };
  }, [merchantId, snapshotId, metric, JSON.stringify(params)]);

  return (
    <Sheet open onClose={onClose} title={title}>
      {err && <div className="list-row__d" style={{ color: "var(--danger, #c0392b)" }}>{err}</div>}
      {!data && !err && <div className="list-row__d">Đang tải…</div>}
      {data && (
        <div className="stack" style={{ gap: 10 }}>
          <div className="card card--flat" style={{ display: "flex", justifyContent: "space-between" }}>
            <span className="list-row__d">Tổng khớp chỉ số</span>
            <strong>{formatVnd(data.totalVnd)} · {data.totalCount} bản ghi</strong>
          </div>
          {data.rows.length === 0 && <div className="list-row__d">Không có bản ghi nguồn trong kỳ.</div>}
          {data.rows.map((r) => (
            <button key={r.id} className="list-row" style={{ width: "100%", textAlign: "left", border: "none", background: "var(--surface, #fff)" }}
              onClick={() => r.route && nav(r.route)} disabled={!r.route}>
              <div className="list-row__main">
                <div className="list-row__t">{r.label}</div>
                {r.at && <div className="list-row__d">{r.at}</div>}
              </div>
              <div className="list-row__v">
                {r.amountVnd != null ? formatVnd(r.amountVnd) : ""}
                {r.qty != null ? ` · SL ${formatQty(r.qty)}` : ""}
                {r.route && <IconChevron size={16} />}
              </div>
            </button>
          ))}
          {data.truncated && <div className="list-row__d">Hiển thị {data.rows.length} bản ghi đầu; tổng vẫn khớp toàn kỳ.</div>}
        </div>
      )}
    </Sheet>
  );
}

// ── Compare sheet: pick a compatible snapshot, show deltas (spec 3.6/4.3) ──────
export function CompareSheet({
  merchantId, baseId, onClose,
}: { merchantId: string; baseId: string; onClose: () => void }) {
  const [list, setList] = useState<ReportListItem[] | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [result, setResult] = useState<ReportCompare | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.reportList(merchantId).then((r) => setList(r.snapshots.filter((s) => s.id !== baseId))).catch((e) => setErr(e.message));
  }, [merchantId, baseId]);

  async function run(id: string) {
    setPick(id); setResult(null); setErr(null);
    try { setResult(await api.reportCompare(merchantId, baseId, id)); }
    catch (e) { setErr((e as Error).message || "Không so sánh được."); }
  }

  return (
    <Sheet open onClose={onClose} title="So sánh kỳ trước">
      <div className="stack" style={{ gap: 12 }}>
        <div className="list-row__d">Chọn một báo cáo cùng độ dài, phạm vi và công thức để so sánh.</div>
        {err && <div className="list-row__d" style={{ color: "var(--danger, #c0392b)" }}>{err}</div>}
        {!list && <div className="list-row__d">Đang tải danh sách…</div>}
        {list && list.length === 0 && <div className="list-row__d">Chưa có báo cáo nào khác để so sánh.</div>}
        {list && list.map((s) => (
          <button key={s.id} className={`list-row ${pick === s.id ? "pill--active" : ""}`} style={{ width: "100%", textAlign: "left", border: "none", background: "var(--surface, #fff)" }} onClick={() => run(s.id)}>
            <div className="list-row__main">
              <div className="list-row__t">{s.periodLabel}</div>
              <div className="list-row__d">{s.days} ngày · bản {s.revision} · {s.status === "superseded" ? "đã thay thế" : "mới nhất"}</div>
            </div>
            <div className="list-row__v">{s.netVnd != null ? formatVnd(s.netVnd) : "—"}</div>
          </button>
        ))}

        {result && !result.compatible && (
          <div className="card card--flat" style={{ background: "var(--amber-050, #fff7e6)" }}>
            <div className="list-row__t">Không thể so sánh trực tiếp</div>
            <ul style={{ margin: "6px 0 0 16px", padding: 0 }}>
              {(result.reasons || []).map((r, i) => <li key={i} className="list-row__d">{r}</li>)}
            </ul>
          </div>
        )}
        {result && result.compatible && (
          <div className="stack" style={{ gap: 8 }}>
            <div className="list-row__d">{result.base.periodLabel} → {result.compare.periodLabel}</div>
            {(result.rows || []).map((row) => (
              <div key={row.code} className="card card--flat" style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 4 }}>
                <div className="list-row__t">{row.label}</div>
                <div className="list-row__v" style={{ textAlign: "right" }}>
                  {row.valueType === "vnd" ? formatVnd(row.compareValue) : formatQty(row.compareValue)}
                </div>
                <div className="list-row__d">gốc {row.valueType === "vnd" ? formatVnd(row.baseValue) : formatQty(row.baseValue)}</div>
                <div className="list-row__d" style={{ textAlign: "right" }}>
                  {row.valueType === "vnd" ? formatDelta(row.delta) : (row.delta >= 0 ? "+" : "−") + formatQty(Math.abs(row.delta))} · {pctText(row.pct)}
                </div>
              </div>
            ))}
            <div className="list-row__d">Mũi tên/không màu: đây là chênh lệch, không phải đánh giá tốt/xấu.</div>
          </div>
        )}
      </div>
    </Sheet>
  );
}
