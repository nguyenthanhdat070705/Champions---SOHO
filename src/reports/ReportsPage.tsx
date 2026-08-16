// Functional 13 — "Báo cáo kinh doanh tối giản". Snapshot-based, immutable report
// over the merchant's own committed data. Unlike Trang Hôm nay (real-time), this
// screen shows a reproducible snapshot with a data-quality coverage banner, drill-
// down that reconciles to the numbers, period comparison and CSV export. Every
// number carries a formula, source and coverage; missing data is never shown as 0.
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMerchant } from "../dashboard/MerchantContext";
import { PageHeader, EmptyState } from "../components/ui";
import { IconChart, IconDownload, IconRefresh, IconInfo, IconClock } from "../components/icons";
import { formatVnd } from "../lib/format";
import { REPORT_PRESETS, asOfText, coverageMeta } from "../lib/reports";
import { api, fetchBlob, newIdempotencyKey } from "../lib/api";
import type { ReportSnapshotDto, Coverage } from "../lib/api";
import { CoverageChip, MetricCard, BarList, Section, DrilldownSheet, CompareSheet } from "./parts";

type Preset = "day" | "week" | "month" | "quarter";
type Tab = "overview" | "sales" | "expenses" | "cashflow" | "estimate" | "quality";
const TABS: { v: Tab; label: string }[] = [
  { v: "overview", label: "Tổng quan" },
  { v: "sales", label: "Bán hàng" },
  { v: "expenses", label: "Chi phí" },
  { v: "cashflow", label: "Dòng tiền" },
  { v: "estimate", label: "Tạm tính" },
  { v: "quality", label: "Nguồn" },
];

interface Drill { metric: string; title: string; params?: Record<string, string> }

export function ReportsPage() {
  const nav = useNavigate();
  const { loading: mLoading, merchant, role } = useMerchant();
  const [preset, setPreset] = useState<Preset>("month");
  const [tab, setTab] = useState<Tab>("overview");
  const [dto, setDto] = useState<ReportSnapshotDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "build" | "export">("");
  const [drill, setDrill] = useState<Drill | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);

  const merchantId = merchant?.id ?? null;
  const canView = role === "owner" || role === "manager";

  const build = useCallback(async (p: Preset, rebuild = false) => {
    if (!merchantId) return;
    setLoading(true); setError(null);
    if (rebuild) setBusy("build");
    try {
      const r = await api.reportBuild(merchantId, { preset: p, rebuild }, newIdempotencyKey());
      setDto(r.snapshot);
    } catch (e) {
      setError((e as Error).message || "Không tạo được báo cáo.");
    } finally {
      setLoading(false); setBusy("");
    }
  }, [merchantId]);

  useEffect(() => { if (merchantId && canView) void build(preset); }, [merchantId, canView, preset, build]);

  async function openNewer() {
    const id = dto?.snapshot.newer?.id;
    if (!merchantId || !id) return;
    setLoading(true);
    try { setDto(await api.reportGet(merchantId, id)); } finally { setLoading(false); }
  }

  async function doExport() {
    if (!merchantId || !dto) return;
    setBusy("export");
    try {
      const exp = await api.reportCreateExport(merchantId, dto.snapshot.id);
      const blob = await fetchBlob(exp.downloadPath);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `bao-cao_${dto.snapshot.periodStart}_${dto.snapshot.periodEnd}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message || "Không xuất được tệp.");
    } finally {
      setBusy("");
    }
  }

  if (mLoading) return <div className="screen screen--tabbed"><PageHeader title="Báo cáo" onBack={() => nav("/")} /><div className="content--plain"><div className="list-row__d">Đang tải…</div></div></div>;
  if (!canView) {
    return (
      <div className="screen screen--tabbed">
        <PageHeader title="Báo cáo" onBack={() => nav("/")} />
        <div className="content--plain">
          <EmptyState icon={<IconChart size={28} />} title="Không có quyền xem báo cáo"
            desc="Báo cáo tổng thể dành cho chủ hộ và quản lý. Doanh thu ngày vẫn có ở Trang Hôm nay." />
        </div>
      </div>
    );
  }

  const s = dto?.sections;
  const cov = dto?.coverage;

  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Báo cáo" onBack={() => nav("/")} right={
        <button className="iconbtn" onClick={() => build(preset, true)} disabled={loading} aria-label="Tạo lại" title="Tạo lại bản mới">
          <IconRefresh size={20} className={busy === "build" ? "iconbtn--spin" : ""} />
        </button>
      } />

      <div className="content--plain stack" style={{ gap: 12 }}>
        {/* Period picker */}
        <div className="segment">
          {REPORT_PRESETS.map((o) => (
            <button key={o.v} className={`segment__btn ${preset === o.v ? "segment__btn--on" : ""}`} onClick={() => setPreset(o.v)}>{o.label}</button>
          ))}
        </div>

        {/* Distinction note: snapshot vs real-time */}
        <div className="list-row__d" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <IconInfo size={14} /> Báo cáo là bản chụp theo kỳ (có thể tái lập). Số thời gian thực ở Trang Hôm nay.
        </div>

        {error && <div className="card card--flat" style={{ color: "var(--danger, #c0392b)" }}>{error}</div>}
        {loading && !dto && <div className="list-row__d">Đang tổng hợp báo cáo…</div>}

        {dto && s && cov && (
          <>
            {dto.snapshot.newer && (
              <div className="card card--flat" style={{ background: "var(--amber-050, #fff7e6)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span className="list-row__d">Có dữ liệu cập nhật (bản {dto.snapshot.newer.revision}).</span>
                <button className="btn btn--outline" onClick={openNewer}>Xem bản mới</button>
              </div>
            )}

            {/* Tabs */}
            <div className="seg-scroll">
              {TABS.map((t) => (
                <button key={t.v} className={`chip ${tab === t.v ? "chip--on" : ""}`} onClick={() => setTab(t.v)}>{t.label}</button>
              ))}
            </div>

            {tab === "overview" && (
              <>
                <CoverageBanner coverage={cov} onOpen={() => setTab("quality")} />
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <MetricCard label="Doanh thu thuần" value={formatVnd(s.sales.netVnd)} sub={`${s.sales.billCount} bill`} onClick={() => setTab("sales")} />
                  <MetricCard label="Chi vận hành" value={formatVnd(s.expense.totalVnd)} sub="đã ghi nhận" onClick={() => setTab("expenses")} />
                  <MetricCard label="Tiền thu (bán hàng)" value={formatVnd(s.cashflow.cashCollectedVnd)} sub="tiền mặt + QR" onClick={() => setTab("cashflow")} />
                  <MetricCard label="Kết quả tạm tính" value={s.estimate.coverage === "unavailable" ? "—" : formatVnd(s.estimate.valueVnd)} sub="ước tính" coverage={s.estimate.coverage} onClick={() => setTab("estimate")} />
                </div>
                <div className="card card--flat" style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn--outline" style={{ flex: 1 }} onClick={() => setCompareOpen(true)}>So sánh kỳ trước</button>
                  <button className="btn btn--outline" style={{ flex: 1, display: "flex", justifyContent: "center", alignItems: "center", gap: 6 }} onClick={doExport} disabled={busy === "export"}>
                    <IconDownload size={16} /> {busy === "export" ? "Đang xuất…" : "Xuất CSV"}
                  </button>
                </div>
                <MetaFooter dto={dto} />
              </>
            )}

            {tab === "sales" && (
              <>
                <Section title="Doanh thu bán">
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <MetricCard label="Doanh thu gộp" value={formatVnd(s.sales.grossVnd)} onClick={() => setDrill({ metric: "sales_gross_revenue", title: "Bill trong kỳ" })} />
                    <MetricCard label="Doanh thu thuần" value={formatVnd(s.sales.netVnd)} sub={`đã trừ hoàn ${formatVnd(s.sales.refundVnd)}`} />
                    <MetricCard label="Số bill" value={String(s.sales.billCount)} onClick={() => setDrill({ metric: "sales_bill_count", title: "Bill trong kỳ" })} />
                    <MetricCard label="Bill trung bình" value={formatVnd(s.sales.billAvgVnd)} />
                  </div>
                </Section>
                <Section title="Theo kênh thu">
                  <BarList rows={s.sales.byChannel.map((c) => ({ label: c.label, value: c.netVnd, onClick: () => setDrill({ metric: "sales_by_channel", title: `Thu — ${c.label}`, params: { channel: c.channel } }) }))} />
                </Section>
                {s.sales.byDay.length > 1 && (
                  <Section title="Theo ngày">
                    <BarList rows={s.sales.byDay.map((d) => ({ label: d.date, value: d.netVnd, onClick: () => setDrill({ metric: "sales_by_day", title: `Bill ngày ${d.date}`, params: { date: d.date } }) }))} />
                  </Section>
                )}
                <Section title="Top sản phẩm" right={<CoverageChip status={s.sales.topCoverage} />}>
                  {s.sales.topCoverage === "unavailable" ? (
                    <div className="list-row__d">Chưa đủ dữ liệu chi tiết dòng để xếp hạng sản phẩm. Bill cũ chưa có chi tiết dòng.</div>
                  ) : (
                    <BarList rows={s.sales.topProducts.map((t) => ({ label: `${t.rank}. ${t.name}`, value: t.revenueVnd, sub: `SL ${t.qty}`, onClick: t.productId ? () => setDrill({ metric: "sales_top_products", title: t.name, params: { productId: t.productId! } }) : undefined }))} />
                  )}
                </Section>
              </>
            )}

            {tab === "expenses" && (
              <>
                <Section title="Chi vận hành đã ghi">
                  <MetricCard label="Tổng chi vận hành" value={formatVnd(s.expense.totalVnd)} coverage={s.expense.coverage} onClick={() => setDrill({ metric: "operating_expense", title: "Khoản chi trong kỳ" })} />
                  <div className="list-row__d">Mua hàng/nhập kho được tách riêng, không tính vào chi vận hành.</div>
                </Section>
                <Section title="Theo nhóm chi">
                  <BarList rows={s.expense.byCategory.map((c) => ({ label: c.categoryName, value: c.totalVnd, onClick: c.categoryId ? () => setDrill({ metric: "expense_by_category", title: c.categoryName, params: { categoryId: c.categoryId! } }) : undefined }))} />
                </Section>
                <Section title="Mua hàng / Tồn kho">
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <MetricCard label="Nhập hàng (phiếu nhập)" value={formatVnd(s.inventory.purchaseVnd)} sub="không phải chi phí kỳ" onClick={() => setDrill({ metric: "inventory_purchase", title: "Phiếu nhập trong kỳ" })} />
                    <MetricCard label="Hao hụt / hủy" value={`${s.inventory.damageCount} lần`} sub={`SL ${s.inventory.damageQty}`} onClick={() => setDrill({ metric: "inventory_damage", title: "Bút toán hao hụt" })} />
                  </div>
                </Section>
              </>
            )}

            {tab === "cashflow" && (
              <>
                <div className="card card--flat" style={{ background: "var(--navy-050, #eef3fb)" }}>
                  <div className="list-row__d">Dữ liệu tiền của SoHo (giao dịch), không phải số dư ngân hàng. Sổ thu–chi đầy đủ (F11) sẽ bổ sung sau.</div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <MetricCard label="Tiền thu (bán hàng)" value={formatVnd(s.cashflow.cashCollectedVnd)} onClick={() => setDrill({ metric: "cash_collected", title: "Thanh toán trong kỳ" })} />
                  <MetricCard label="Tiền chi (chi phí đã ghi)" value={formatVnd(s.cashflow.expensePaidVnd)} onClick={() => setDrill({ metric: "operating_expense", title: "Khoản chi trong kỳ" })} />
                </div>
                <MetricCard label="Chênh lệch tiền (tạm)" value={formatVnd(s.cashflow.deltaVnd)} sub="Thu − Chi đã ghi. Không gọi là lợi nhuận." />
              </>
            )}

            {tab === "estimate" && (
              <Section title="Kết quả vận hành tạm tính" right={<CoverageChip status={s.estimate.coverage} />}>
                {s.estimate.coverage === "unavailable" ? (
                  <div className="list-row__d">Chưa đủ độ phủ dữ liệu để hiển thị số. Hãy kiểm tra mục Nguồn.</div>
                ) : (
                  <div className="stat-card__value" style={{ fontSize: 30 }}>{formatVnd(s.estimate.valueVnd)}</div>
                )}
                <div className="card card--flat">
                  <div className="list-row__t" style={{ fontSize: 13 }}>Cách tính</div>
                  <div className="list-row__d">{s.estimate.formula}</div>
                </div>
                <div className="card card--flat" style={{ background: "var(--amber-050, #fff7e6)" }}>
                  <div className="list-row__t" style={{ fontSize: 13 }}>Chưa gồm / lưu ý</div>
                  <ul style={{ margin: "6px 0 0 16px", padding: 0 }}>
                    {s.estimate.disclosures.map((d, i) => <li key={i} className="list-row__d">{d}</li>)}
                  </ul>
                </div>
              </Section>
            )}

            {tab === "quality" && (
              <>
                <CoverageBanner coverage={cov} />
                <Section title="Nguồn dữ liệu & độ phủ">
                  <div className="stack" style={{ gap: 8 }}>
                    {cov.sources.map((q) => (
                      <div key={q.sourceType} className="list-row" style={{ background: "var(--surface, #fff)" }}>
                        <div className="list-row__main">
                          <div className="list-row__t">{q.label}</div>
                          <div className="list-row__d">{q.processed}/{q.expected} bản ghi{q.openIssues > 0 ? ` · ${q.openIssues} vấn đề` : ""}</div>
                        </div>
                        <CoverageChip status={q.status as Coverage} />
                      </div>
                    ))}
                  </div>
                </Section>
                <MetaFooter dto={dto} />
              </>
            )}
          </>
        )}
      </div>

      {drill && merchantId && dto && (
        <DrilldownSheet merchantId={merchantId} snapshotId={dto.snapshot.id} metric={drill.metric} title={drill.title} params={drill.params} onClose={() => setDrill(null)} />
      )}
      {compareOpen && merchantId && dto && (
        <CompareSheet merchantId={merchantId} baseId={dto.snapshot.id} onClose={() => setCompareOpen(false)} />
      )}
    </div>
  );
}

function CoverageBanner({ coverage, onOpen }: { coverage: ReportSnapshotDto["coverage"]; onOpen?: () => void }) {
  const meta = coverageMeta(coverage.overall);
  const bg = meta.tone === "good" ? "var(--teal-050, #e8f7f1)" : meta.tone === "amber" ? "var(--amber-050, #fff7e6)" : "var(--navy-050, #eef3fb)";
  return (
    <div className="card card--flat" style={{ background: bg }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div className="list-row__t">Độ đầy đủ dữ liệu: {coverage.percent}%</div>
        <CoverageChip status={coverage.overall} />
      </div>
      {coverage.notes.map((n, i) => <div key={i} className="list-row__d" style={{ marginTop: 4 }}>{n}</div>)}
      {coverage.notes.length === 0 && <div className="list-row__d" style={{ marginTop: 4 }}>Các nguồn dữ liệu đã đầy đủ cho kỳ này.</div>}
      {onOpen && <button className="link-btn" style={{ marginTop: 6 }} onClick={onOpen}>Xem nguồn & độ đầy đủ →</button>}
    </div>
  );
}

function MetaFooter({ dto }: { dto: ReportSnapshotDto }) {
  const s = dto.snapshot;
  return (
    <div className="card card--flat stack" style={{ gap: 4 }}>
      <div className="list-row__d" style={{ display: "flex", gap: 6, alignItems: "center" }}><IconClock size={13} /> Mốc dữ liệu (as_of): {asOfText(s.asOf)}</div>
      <div className="list-row__d">Kỳ: {s.periodLabel} · {s.timezone}</div>
      <div className="list-row__d">Công thức: {s.formulaVersion} · bản {s.revision}{s.status === "superseded" ? " (đã thay thế)" : ""}</div>
      {s.contentHash && <div className="list-row__d" style={{ fontFamily: "monospace", fontSize: 11 }}>hash {s.contentHash.slice(0, 16)}</div>}
    </div>
  );
}
