import { useNavigate } from "react-router-dom";
import { PageHeader, EmptyState, LoadingScreen } from "../components/ui";
import { IconCheck } from "../components/icons";
import { useMerchant } from "./MerchantContext";
import { useTodayDashboard } from "./useTodayDashboard";
import { derivePriorityItems } from "../lib/dashboard";
import { AttentionRow } from "./Home";

// "Xem tất cả" target for Việc cần xử lý (spec 2, position 06). Lists every
// derived priority item (not the top-3 preview) and routes each to the screen
// that resolves it.
export function AttentionListPage() {
  const nav = useNavigate();
  const { merchant } = useMerchant();
  const { status, data } = useTodayDashboard(merchant?.id ?? null);

  const items = data
    ? derivePriorityItems(data.snapshot, data.actions, 50)
    : [];

  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Việc cần xử lý" onBack={() => nav("/")} />
      <div className="content--plain">
        {status === "loading" && !data ? (
          <LoadingScreen />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<IconCheck size={30} />}
            title="Không có việc cần xử lý"
            desc="Mọi thứ đang ổn. Khi có QR chờ xác nhận, hàng sắp hết hoặc cảnh báo hệ thống, chúng sẽ hiện ở đây."
          />
        ) : (
          <div className="attn">
            {items.map((it) => (
              <AttentionRow
                key={it.key}
                item={it}
                onClick={() => nav(it.to)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
