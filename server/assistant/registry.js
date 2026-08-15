// Deep-link registry for source cards + "Làm tiếp" action chips (spec 3.5 / 3.1).
// The model NEVER emits URLs; it only picks keys from these allowlists and the
// server resolves each key to a { label, route } the client can render + navigate
// (spec 4.2 "source reference là typed identifier; renderer tạo label/deep-link").
// Every route here is an existing in-app screen that actually shows that data.

/** Source cards: where a number in the answer can be verified in-app. */
export const SOURCES = Object.freeze({
  today: { label: "Trang Hôm nay", route: "/" },
  inventory: { label: "Kho", route: "/kho" },
  orders: { label: "Đơn hàng", route: "/don-hang" },
  reports: { label: "Báo cáo", route: "/bao-cao" },
  attention: { label: "Việc cần xử lý", route: "/viec-can-xu-ly" },
  tax: { label: "Thuế", route: "/thue" },
  settings: { label: "Cài đặt", route: "/cai-dat" },
});

/** "Làm tiếp" chips: allowlisted next-step deep-links (open a screen / tạo bill). */
export const ACTIONS = Object.freeze({
  open_today: { label: "Xem Trang Hôm nay", route: "/" },
  open_inventory: { label: "Mở Kho", route: "/kho" },
  open_orders: { label: "Mở Đơn hàng", route: "/don-hang" },
  create_bill: { label: "Tạo bill mới", route: "/ban-hang" },
  open_attention: { label: "Xem việc cần xử lý", route: "/viec-can-xu-ly" },
  open_reports: { label: "Mở Báo cáo", route: "/bao-cao" },
  open_tax: { label: "Mở màn hình Thuế", route: "/thue" },
});

export const SOURCE_KEYS = Object.keys(SOURCES);
export const ACTION_KEYS = Object.keys(ACTIONS);

function resolve(keys, table, limit) {
  const out = [];
  const seen = new Set();
  for (const k of Array.isArray(keys) ? keys : []) {
    const key = typeof k === "string" ? k.trim() : "";
    if (!table[key] || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label: table[key].label, route: table[key].route });
    if (out.length >= limit) break;
  }
  return out;
}

/** Resolve up to 3 valid source keys → renderable cards (unknown keys dropped). */
export function resolveSources(keys) {
  return resolve(keys, SOURCES, 3);
}

/** Resolve up to 3 valid action keys → renderable chips (unknown keys dropped). */
export function resolveActions(keys) {
  return resolve(keys, ACTIONS, 3);
}
