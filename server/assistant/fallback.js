// Deterministic, no-AI answerer (spec 11.2 / AST-FR-12: "Fallback native khi AI
// lỗi ... 100% core flows"). Two jobs: (1) power the whole page when Gemini is
// disabled/down, (2) be the safe replacement whenever a model reply fails the
// number post-check. Every sentence is built straight from the FACTS pack, so its
// numbers are grounded by construction. Vietnamese, plain words, never claims an
// action was performed, never uses "công nợ"/"chưa thu".
import { formatVnd } from "../f3/format.js";

/** Lowercase + strip Vietnamese diacritics for robust keyword matching. */
export function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d");
}

const has = (t, ...kws) => kws.some((k) => t.includes(k));

/** Classify the latest user message into a coarse intent (spec 4.1 tiering). */
export function detectIntent(text) {
  const t = normalize(text);
  // Out of scope for the FACTS pack (no cost/profit data; no month/quarter/year
  // aggregates) → be honest rather than answer with the wrong number.
  if (has(t, "loi nhuan", "lai rong", "lai gop", "bien loi", "gia von", "von hang", "tien lai"))
    return "unknown";
  if (has(t, "thang nay", "thang truoc", "thang qua", "quy nay", "quy truoc", "nam nay", "nam ngoai", "ca nam"))
    return "unknown";
  // T2/T3 write requests for functionals not built yet (F7–F9) → honest "sắp có".
  if (has(t, "ghi chi phi", "ghi tien", "chi phi", "khoan chi", "khoan thu", "ghi khoan"))
    return "do_expense";
  if (has(t, "nhap hang", "nhap kho", "nhap them", "them ton", "cong ton", "dat hang"))
    return "do_inventory";
  if (has(t, "hoa don", "xuat hoa don", "phat hanh hoa don", "hoa don do", "vat"))
    return "do_invoice";
  if (has(t, "thue", "khai thue", "nop thue")) return "tax";
  // T1 read intents.
  if (has(t, "sap het", "het hang", "ton kho", "con bao nhieu hang", "kho hang") || (has(t, "kho") && !has(t, "khong")))
    return "low_stock";
  if (has(t, "tuan nay", "tuan truoc", "so voi tuan", "so tuan", "tuan qua"))
    return "week_compare";
  if (has(t, "ban chay", "nhieu nhat", "top", "mon nao ban", "san pham nao ban", "hang nao ban"))
    return "top_products";
  if (has(t, "viec", "can xu ly", "can lam", "chu y", "canh bao", "xu ly gi"))
    return "attention";
  if (has(t, "tien mat", "chuyen khoan", "qr", "bao nhieu tien mat"))
    return "cash_qr";
  if (has(t, "hom nay", "doanh thu", "ban duoc", "ban dc", "thu duoc", "bao nhieu", "doanh so", "hom qua"))
    return "revenue_today";
  if (has(t, "chao", "hello", "hi ", "xin chao", "ban la ai", "giup gi", "lam duoc gi"))
    return "greeting";
  return "unknown";
}

function pendingSentence(f) {
  return f.today.pendingQrCount > 0
    ? ` Có ${f.today.pendingQrCount} giao dịch QR đang chờ xác nhận, chưa được tính vào doanh thu.`
    : "";
}

/**
 * Build a grounded answer for `userText` from the FACTS pack.
 * Returns { kind, message, sourceKeys, actionKeys }.
 */
export function fallbackAnswer(f, userText) {
  const intent = detectIntent(userText);

  switch (intent) {
    case "revenue_today": {
      const msg =
        `Hôm nay cửa hàng bán được ${formatVnd(f.today.net)} (doanh thu thuần), từ ${f.today.paidOrderCount} bill. ` +
        `Trong đó tiền mặt ${formatVnd(f.today.cashNet)}, chuyển khoản/QR ${formatVnd(f.today.qrNet)}.` +
        pendingSentence(f);
      return { kind: "answer", message: msg, sourceKeys: ["today"], actionKeys: ["open_today", "create_bill"] };
    }
    case "cash_qr": {
      const msg = `Hôm nay tiền mặt thu ${formatVnd(f.today.cashNet)} và chuyển khoản/QR ${formatVnd(f.today.qrNet)}. Tổng doanh thu thuần ${formatVnd(f.today.net)}.` + pendingSentence(f);
      return { kind: "answer", message: msg, sourceKeys: ["today"], actionKeys: ["open_today"] };
    }
    case "low_stock": {
      if (f.lowStock.length === 0) {
        return { kind: "answer", message: "Hiện không có sản phẩm nào sắp hết hàng. Kho vẫn ổn.", sourceKeys: ["inventory"], actionKeys: ["open_inventory"] };
      }
      const list = f.lowStock.map((p) => `• ${p.name}: còn ${p.onHand} (ngưỡng ${p.threshold})`).join("\n");
      const msg = `Có ${f.today.lowStockCount} sản phẩm sắp hết hàng:\n${list}\nBạn nên kiểm tra và nhập thêm.`;
      return { kind: "answer", message: msg, sourceKeys: ["inventory"], actionKeys: ["open_inventory"] };
    }
    case "week_compare": {
      const dir = f.week.direction === "up" ? "tăng" : f.week.direction === "down" ? "giảm" : "không đổi";
      const pct = f.week.deltaPercent != null ? ` (${Math.abs(f.week.deltaPercent)}%)` : "";
      const msg =
        `7 ngày qua cửa hàng bán được ${formatVnd(f.week.last7Net)}. 7 ngày trước đó là ${formatVnd(f.week.prev7Net)}. ` +
        (f.week.direction === "flat"
          ? "Hai tuần gần như bằng nhau."
          : `Tuần này ${dir} ${formatVnd(Math.abs(f.week.deltaAmount))}${pct} so với tuần trước.`);
      return { kind: "answer", message: msg, sourceKeys: ["reports", "today"], actionKeys: ["open_reports"] };
    }
    case "top_products": {
      if (f.topProducts.length === 0) {
        return { kind: "answer", message: "Chưa có dữ liệu bán hàng trong 7 ngày qua để xếp hạng sản phẩm.", sourceKeys: ["orders"], actionKeys: ["create_bill"] };
      }
      const list = f.topProducts.map((p, i) => `${i + 1}. ${p.name} — bán ${p.qty}, doanh thu ${formatVnd(p.revenue)}`).join("\n");
      const msg = `Sản phẩm bán chạy nhất 7 ngày qua:\n${list}`;
      return { kind: "answer", message: msg, sourceKeys: ["orders"], actionKeys: ["open_orders"] };
    }
    case "attention": {
      const bits = [];
      if (f.today.openActionCount > 0) bits.push(`${f.today.openActionCount} việc cần xử lý`);
      if (f.today.pendingQrCount > 0) bits.push(`${f.today.pendingQrCount} giao dịch QR đang chờ`);
      if (f.today.lowStockCount > 0) bits.push(`${f.today.lowStockCount} sản phẩm sắp hết hàng`);
      if (bits.length === 0) {
        return { kind: "answer", message: "Hiện không có việc gì gấp cần xử lý. Mọi thứ đang ổn.", sourceKeys: ["attention"], actionKeys: ["open_attention"] };
      }
      const actionList = f.openActions.length ? "\n" + f.openActions.map((a) => `• ${a.title}`).join("\n") : "";
      return { kind: "answer", message: `Bạn có: ${bits.join(", ")}.${actionList}`, sourceKeys: ["attention"], actionKeys: ["open_attention", "open_inventory"] };
    }
    case "do_expense":
      return {
        kind: "refusal",
        message: "Tính năng ghi khoản thu/chi bằng trợ lý đang được xây dựng, sắp có. Hiện tại bạn có thể xem doanh thu và tiền mặt/chuyển khoản ở Trang Hôm nay.",
        sourceKeys: ["today"],
        actionKeys: ["open_today"],
      };
    case "do_inventory":
      return {
        kind: "refusal",
        message: "Trợ lý chưa nhập kho trực tiếp được (tính năng đang xây, sắp có). Bạn có thể mở màn hình Kho để xem và chỉnh tồn.",
        sourceKeys: ["inventory"],
        actionKeys: ["open_inventory"],
      };
    case "do_invoice":
      return {
        kind: "refusal",
        message: "Việc phát hành hóa đơn chưa có trong trợ lý (đang xây, sắp có). Với câu hỏi về thuế/hóa đơn, bạn nên mở màn hình Thuế để xem hướng dẫn.",
        sourceKeys: ["tax"],
        actionKeys: ["open_tax"],
      };
    case "tax":
      return {
        kind: "refusal",
        message: "Về thuế và hóa đơn, trợ lý không đưa ra kết luận thay bạn. Bạn hãy mở màn hình Thuế trong ứng dụng để xem thông tin chính thức.",
        sourceKeys: ["tax"],
        actionKeys: ["open_tax"],
      };
    case "greeting":
      return {
        kind: "answer",
        message:
          "Chào bạn! Tôi là Trợ lý SoHo. Tôi có thể trả lời về doanh thu hôm nay, tiền mặt và chuyển khoản, sản phẩm sắp hết hàng, so sánh tuần này với tuần trước, và việc cần xử lý. Bạn muốn hỏi gì?",
        sourceKeys: [],
        actionKeys: ["open_today", "open_inventory"],
      };
    default:
      return {
        kind: "answer",
        message:
          "Xin lỗi, tôi chưa đủ dữ liệu để trả lời chắc chắn câu này. Tôi có thể giúp về: doanh thu hôm nay, tiền mặt/chuyển khoản, sản phẩm sắp hết hàng, so sánh tuần, và việc cần xử lý.",
        sourceKeys: [],
        actionKeys: ["open_today", "open_inventory"],
      };
  }
}
