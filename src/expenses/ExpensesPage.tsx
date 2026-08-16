// Functional 07 — "Chi phí" list (spec 3.1). A lean lookup: search, status
// filters, a month header with the posted total, and cards. Not an analytics
// dashboard (spec 3.1 rule). FAB → "Ghi khoản chi". Owner/manager see the FAB;
// a cashier is view-only per policy (server enforces post/reverse).
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/ui";
import { IconSearch, IconPlus, IconWallet, IconReceipt } from "../components/icons";
import { useMerchant } from "../dashboard/MerchantContext";
import { api } from "../lib/api";
import type { ExpenseListResult } from "../lib/api";
import { formatVnd } from "../lib/format";
import { useDebounced } from "../catalog/parts";
import { STATUS_FILTERS, currentMonth, monthLabel, paymentLabel } from "../lib/expenses";
import { StatusBadge } from "./parts";

export function ExpensesPage() {
  const nav = useNavigate();
  const { merchant, role } = useMerchant();
  const merchantId = merchant?.id ?? "";
  const canManage = role === "owner" || role === "manager";

  const [data, setData] = useState<ExpenseListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [month] = useState(currentMonth());
  const debouncedSearch = useDebounced(search, 280);

  function load() {
    if (!merchantId) return;
    setLoading(true);
    api.listExpenses(merchantId, { month, status, search: debouncedSearch.trim() || undefined })
      .then(setData)
      .catch(() => setData({ month, expenses: [], summary: { postedTotalVnd: 0, postedCount: 0 } }))
      .finally(() => setLoading(false));
  }
  useEffect(load, [merchantId, debouncedSearch, status, month]); // eslint-disable-line react-hooks/exhaustive-deps

  const expenses = data?.expenses ?? [];

  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Chi phí" onBack={() => nav("/")} />
      <div className="content--plain catalog">
        <div className="card" style={{ marginBottom: 12, textAlign: "center", padding: "14px 12px" }}>
          <div className="muted tiny">{monthLabel(month)} · đã ghi nhận</div>
          <div style={{ fontSize: 26, fontWeight: 800, marginTop: 2 }}>{formatVnd(data?.summary.postedTotalVnd ?? 0)}</div>
          <div className="muted tiny">{data?.summary.postedCount ?? 0} khoản chi</div>
        </div>

        <div className="pos-search" style={{ padding: 0, marginBottom: 10 }}>
          <div className="pos-search__box">
            <IconSearch size={19} />
            <input className="pos-search__input" placeholder="Tìm số CT hoặc bên nhận…" value={search}
              onChange={(e) => setSearch(e.target.value)} inputMode="search" />
          </div>
        </div>

        <div className="seg-scroll">
          {STATUS_FILTERS.map((f) => (
            <button key={f.key} className={`chip ${status === f.key ? "chip--on" : ""}`} onClick={() => setStatus(f.key)}>
              {f.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="muted" style={{ textAlign: "center", padding: 30 }}>Đang tải…</div>
        ) : expenses.length === 0 ? (
          <div className="empty" style={{ marginTop: 20 }}>
            <div className="empty__ic"><IconWallet size={28} /></div>
            <div className="empty__t">{search ? "Không tìm thấy" : "Chưa có khoản chi tháng này"}</div>
            <div className="empty__d">{search ? "Thử từ khóa khác." : "Chụp hóa đơn hoặc nhập tay để ghi khoản chi đầu tiên."}</div>
          </div>
        ) : (
          <div className="stack" style={{ marginTop: 12 }}>
            {expenses.map((e) => (
              <button key={e.id} className="card card--flat" onClick={() => nav(`/chi-phi/${e.id}`)}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, width: "100%", textAlign: "left" }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 600 }}>{e.payeeName || e.categoryName || "Khoản chi"}</span>
                    <StatusBadge status={e.status} />
                    {e.hasDocument && <IconReceipt size={13} />}
                  </div>
                  <div className="muted tiny">
                    {e.expenseDate}{e.categoryName ? ` · ${e.categoryName}` : ""}
                    {e.paymentMethod ? ` · ${paymentLabel(e.paymentMethod, e.paymentStatus)}` : ""}
                  </div>
                </div>
                <div style={{ fontWeight: 700, whiteSpace: "nowrap", textDecoration: e.status === "reversed" ? "line-through" : "none" }}>
                  {formatVnd(e.grandTotalVnd)}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {canManage && (
        <button className="fab" onClick={() => nav("/chi-phi/moi")} aria-label="Ghi khoản chi">
          <IconPlus size={22} /> <span>Ghi khoản chi</span>
        </button>
      )}
    </div>
  );
}
