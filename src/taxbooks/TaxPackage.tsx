// Functional 15 — locked-snapshot detail + tax data package + export (spec §3.6,
// §3.8). Builds the "tờ khai" data set (revenue by channel + 1-tỷ threshold split
// + estimated GTGT/TNCN), each line source-indexed, with an honest disclaimer.
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMerchant } from "../dashboard/MerchantContext";
import { PageHeader, Banner, LoadingScreen } from "../components/ui";
import { IconDownload, IconShield } from "../components/icons";
import { formatVnd } from "../lib/format";
import { api, ApiError, newIdempotencyKey } from "../lib/api";
import type { TaxSnapshot, TaxPackageResult, TaxExport } from "../lib/api";
import { supabase } from "../lib/supabase";

export function TaxPackage() {
  const nav = useNavigate();
  const { snapshotId = "" } = useParams();
  const { merchant, role } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const canWrite = role === "owner" || role === "manager";
  const [snap, setSnap] = useState<TaxSnapshot | null>(null);
  const [pkg, setPkg] = useState<TaxPackageResult | null>(null);
  const [exports, setExports] = useState<TaxExport[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!merchantId || !snapshotId) return;
    setLoading(true); setErr(null);
    try {
      const s = await api.taxSnapshot(merchantId, snapshotId);
      setSnap(s.snapshot);
      const b = await api.taxBuildPackage(merchantId, snapshotId, newIdempotencyKey());
      setPkg(await api.taxPackage(merchantId, b.packageId));
      setExports((await api.taxListExports(merchantId, snapshotId)).exports);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Không tải được gói dữ liệu.");
    } finally { setLoading(false); }
  }, [merchantId, snapshotId]);

  useEffect(() => { void load(); }, [load]);

  async function onExport(kind: "all_books" | "package") {
    if (!merchantId) return;
    setBusy(true); setErr(null);
    try {
      await api.taxCreateExport(merchantId, { snapshotId, scope: { kind }, format: "csv" });
      setExports((await api.taxListExports(merchantId, snapshotId)).exports);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Tạo tệp thất bại.");
    } finally { setBusy(false); }
  }

  async function onDownload(exp: TaxExport) {
    if (!merchantId) return;
    const path = api.taxExportDownloadUrl(merchantId, exp.id);
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    const res = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${exp.format === "csv" ? "so-ke-toan" : "export"}-${exp.id.slice(0, 8)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading && !pkg) return <LoadingScreen />;

  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Dữ liệu thuế theo kỳ" onBack={() => nav(-1)} />
      <div className="content--plain stack">
        {err && <Banner kind="error">{err}</Banner>}

        {snap && (
          <div className="card">
            <div className="row-between">
              <div className="stat-card__label">Bản chốt v{snap.versionNo}{snap.isCurrent ? " (hiện hành)" : ""}</div>
              <span className="chip chip--teal">Đã khóa</span>
            </div>
            <div className="list-row__d" style={{ marginTop: 2 }}>
              Kỳ {snap.periodStart} → {snap.periodEnd} · rule {snap.ruleVersion} · {snap.catalogCode}
            </div>
            <div className="list-row__d" style={{ marginTop: 2, wordBreak: "break-all" }}>hash {snap.contentHash}</div>
            {snap.previousSnapshotId && (
              <div className="list-row__d" style={{ marginTop: 2 }}>Thay thế bản trước (đã có bản chốt mới hơn).</div>
            )}
          </div>
        )}

        {pkg && (
          <>
            <div className="card">
              <div className="section-title" style={{ marginBottom: 8 }}>Gói dữ liệu thuế (ước tính)</div>
              {pkg.lines.map((l) => (
                <div key={l.sequenceNo} className="row-between" style={{ padding: "7px 0", borderBottom: "1px solid var(--line)", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="list-row__d">{l.label}</div>
                    {l.legalNote && <div className="field__hint" style={{ marginTop: 1 }}>{l.legalNote}</div>}
                  </div>
                  <b style={{ whiteSpace: "nowrap" }}>{l.amountVnd == null ? "—" : formatVnd(l.amountVnd)}</b>
                </div>
              ))}
            </div>

            <Banner kind="warn">{pkg.disclaimer}</Banner>

            {canWrite && (
              <div className="card">
                <div className="section-title" style={{ marginBottom: 8 }}>Xuất tệp (CSV, mở được bằng Excel)</div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button className="btn btn--outline" disabled={busy} onClick={() => onExport("all_books")}>Xuất sổ kế toán</button>
                  <button className="btn btn--outline" disabled={busy} onClick={() => onExport("package")}>Xuất gói dữ liệu thuế</button>
                </div>
              </div>
            )}

            {exports.length > 0 && (
              <div className="stack" style={{ gap: 8 }}>
                {exports.map((e) => (
                  <button key={e.id} className="card list-row" style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left" }} onClick={() => onDownload(e)}>
                    <div className="list-row__ic"><IconShield size={16} /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="list-row__t">{e.objectKey.includes("package") ? "Gói dữ liệu thuế" : "Sổ kế toán"} ({e.format.toUpperCase()})</div>
                      <div className="list-row__d">{new Date(e.createdAt).toLocaleString("vi-VN")}</div>
                    </div>
                    <IconDownload size={18} />
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
