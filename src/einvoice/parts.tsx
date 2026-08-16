// Functional 09 shared UI — status badge, mock-provider disclosure banner, buyer
// form, acknowledgement sheet and the adjust/replace relation sheet. Kept together
// so the list, create and detail screens reuse one set of honest, consistent parts.
import { useState } from "react";
import { Banner, Button, TextField } from "../components/ui";
import { Sheet } from "../sales/ui";
import { CheckRow } from "../components/ui";
import {
  STATUS_META, STATUS_TONE_STYLE, buyerBlockingReason,
} from "../lib/einvoice";
import type { InvoiceStatus, InvoiceBuyer } from "../lib/einvoice";

/** Honest status pill (spec 3.1: never show "Đã gửi" in place of "Đã phát hành"). */
export function StatusBadge({ status }: { status: InvoiceStatus }) {
  const meta = STATUS_META[status] ?? { label: status, tone: "grey" as const };
  const style = STATUS_TONE_STYLE[meta.tone];
  return (
    <span className="pill" style={{ ...style, marginLeft: 0 }}>
      {meta.label}
    </span>
  );
}

/** The MVP-critical honesty banner: no real tax-authority provider is connected. */
export function MockProviderBanner() {
  return (
    <Banner kind="warn">
      Nhà cung cấp thử nghiệm — <b>chưa nối cơ quan thuế</b>. Đây là bản mô phỏng để
      chạy đủ luồng; hóa đơn “Đã phát hành” ở đây chưa có giá trị pháp lý.
    </Banner>
  );
}

/** Buyer info form (spec 3.4). Individual (khách lẻ) may leave everything blank. */
export function BuyerForm({
  buyer, onChange, disabled,
}: {
  buyer: InvoiceBuyer;
  onChange: (next: InvoiceBuyer) => void;
  disabled?: boolean;
}) {
  const set = (patch: Partial<InvoiceBuyer>) => onChange({ ...buyer, ...patch });
  const isOrg = buyer.kind === "organization";
  return (
    <div className="stack">
      <div className="segment">
        <button
          className={`segment__btn ${!isOrg ? "segment__btn--on" : ""}`}
          onClick={() => !disabled && set({ kind: "individual" })}
          disabled={disabled}
        >
          Cá nhân
        </button>
        <button
          className={`segment__btn ${isOrg ? "segment__btn--on" : ""}`}
          onClick={() => !disabled && set({ kind: "organization" })}
          disabled={disabled}
        >
          Tổ chức (có MST)
        </button>
      </div>
      <TextField
        label="Tên người mua"
        value={buyer.name ?? ""}
        onChange={(v) => set({ name: v })}
        placeholder={isOrg ? "Tên công ty" : "Khách lẻ (không bắt buộc)"}
        required={isOrg}
        optional={!isOrg}
        disabled={disabled}
      />
      <TextField
        label="Mã số thuế"
        value={buyer.taxCode ?? ""}
        onChange={(v) => set({ taxCode: v })}
        placeholder="10 hoặc 13 số"
        inputMode="numeric"
        required={isOrg}
        optional={!isOrg}
        disabled={disabled}
      />
      <TextField
        label="Địa chỉ"
        value={buyer.address ?? ""}
        onChange={(v) => set({ address: v })}
        optional
        disabled={disabled}
      />
      <TextField
        label="Email nhận bản xem"
        value={buyer.email ?? ""}
        onChange={(v) => set({ email: v })}
        hint="Chỉ để gửi bản xem; không quyết định hóa đơn được chấp nhận."
        inputMode="email"
        optional
        disabled={disabled}
      />
    </div>
  );
}

export function buyerReason(buyer: InvoiceBuyer): string | null {
  return buyerBlockingReason(buyer);
}

/** Confirm-and-issue sheet with the two mandatory acknowledgements (spec 3.6). */
export function AcknowledgeSheet({
  open, onClose, onConfirm, submitting,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  submitting: boolean;
}) {
  const [buyerReviewed, setBuyerReviewed] = useState(false);
  const [amountsReviewed, setAmountsReviewed] = useState(false);
  const ready = buyerReviewed && amountsReviewed;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Xác nhận phát hành"
      footer={
        <Button
          variant="primary"
          onClick={onConfirm}
          loading={submitting}
          disabled={!ready}
          disabledReason={!ready ? "Vui lòng xác nhận hai mục dưới đây." : undefined}
        >
          Phát hành hóa đơn
        </Button>
      }
    >
      <div className="stack">
        <p className="field__hint">
          Sau khi phát hành, nội dung được khóa và gửi qua nhà cung cấp thử nghiệm.
          Trạng thái “Đã phát hành” chỉ xuất hiện khi có sự kiện đã xác minh.
        </p>
        <CheckRow checked={buyerReviewed} onToggle={() => setBuyerReviewed((v) => !v)}>
          Tôi đã kiểm tra thông tin người mua.
        </CheckRow>
        <CheckRow checked={amountsReviewed} onToggle={() => setAmountsReviewed((v) => !v)}>
          Tôi đã kiểm tra dòng hàng và tổng tiền.
        </CheckRow>
      </div>
    </Sheet>
  );
}

/** Adjust/replace relation sheet for an accepted invoice (spec 3.8 / 4.3). */
export function RelationSheet({
  open, onClose, onConfirm, busy,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (relationType: "adjustment" | "replacement", reason: string) => void;
  busy: boolean;
}) {
  const [relationType, setRelationType] = useState<"adjustment" | "replacement">("adjustment");
  const [reason, setReason] = useState("");
  const ready = reason.trim().length > 0;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Điều chỉnh / Thay thế"
      footer={
        <Button
          variant="navy"
          onClick={() => onConfirm(relationType, reason.trim())}
          loading={busy}
          disabled={!ready}
          disabledReason={!ready ? "Nhập lý do." : undefined}
        >
          Tạo bản nháp {relationType === "replacement" ? "thay thế" : "điều chỉnh"}
        </Button>
      }
    >
      <div className="stack">
        <div className="segment">
          <button className={`segment__btn ${relationType === "adjustment" ? "segment__btn--on" : ""}`} onClick={() => setRelationType("adjustment")}>
            Điều chỉnh
          </button>
          <button className={`segment__btn ${relationType === "replacement" ? "segment__btn--on" : ""}`} onClick={() => setRelationType("replacement")}>
            Thay thế
          </button>
        </div>
        <p className="field__hint">
          Bản gốc được giữ nguyên; hệ thống tạo một bản nháp mới có liên kết. Bản gốc
          chuyển trạng thái khi bản mới được chấp nhận.
        </p>
        <TextField label="Lý do" value={reason} onChange={setReason} placeholder="Ví dụ: sai mã số thuế người mua" required />
      </div>
    </Sheet>
  );
}
