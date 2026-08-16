// Functional 15 — one book's ledger (spec §3.3). Rows carry date, diễn giải,
// amount and a source deep-link; the header total is server-computed.
import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMerchant } from "../dashboard/MerchantContext";
import { PageHeader, Banner, LoadingScreen, EmptyState } from "../components/ui";
import { IconChevron, IconFile } from "../components/icons";
import { formatVnd } from "../lib/format";
import { api, ApiError } from "../lib/api";
import type { TaxBookLedger as Ledger } from "../lib/api";

export function TaxBookLedger() {
  const nav = useNavigate();
  const { bookCode = "" } = useParams();
  const [sp] = useSearchParams();
  const period = sp.get("period") || undefined;
  const { merchant } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const [data, setData] = useState<Ledger | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!merchantId) return;
    setLoading(true); setErr(null);
    api.taxBookLedger(merchantId, bookCode, { period })
      .then(setData)
      .catch((e) => setErr(e instanceof ApiError ? e.message : "Không tải được sổ."))
      .finally(() => setLoading(false));
  }, [merchantId, bookCode, period]);

  if (loading && !data) return <LoadingScreen />;

  return (
    <div className="screen screen--tabbed">
      <PageHeader title={data?.book.short || "Sổ"} onBack={() => nav(-1)} />
      <div className="content--plain stack">
        {err && <Banner kind="error">{err}</Banner>}
        {data && (
          <>
            <div className="card">
              <div className="stat-card__label">{data.book.name}</div>
              <div className="stat-card__value" style={{ fontSize: 24, color: data.total < 0 ? "var(--red, #c0392b)" : undefined }}>{formatVnd(data.total)}</div>
              <div className="list-row__d" style={{ marginTop: 4 }}>{data.period.label} · {data.count} dòng · {data.book.legalRef}</div>
            </div>

            {data.lines.length === 0 ? (
              <EmptyState icon={<IconFile size={28} />} title="Chưa có dòng sổ" desc="Kỳ này chưa có nghiệp vụ nào cho sổ này." />
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                {data.lines.map((l) => (
                  <div key={l.id} className="card list-row" style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div className="list-row__ic"><IconFile size={16} /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="list-row__t">{l.description}</div>
                      <div className="list-row__d">{l.businessDate}{l.source ? ` · ${l.source.label}` : ""}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div className="list-row__t" style={{ color: l.amountVnd < 0 ? "var(--red, #c0392b)" : undefined }}>{formatVnd(l.amountVnd)}</div>
                    </div>
                    {l.source?.route && (
                      <button className="step__back" onClick={() => nav(l.source!.route!)} aria-label="Mở nguồn"><IconChevron size={16} /></button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <p className="field__hint">Mỗi dòng truy ngược được về chứng từ nguồn. Rule: {data.ruleVersion}.</p>
          </>
        )}
      </div>
    </div>
  );
}
