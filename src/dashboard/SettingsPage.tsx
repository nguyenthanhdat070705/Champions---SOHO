import { useState } from "react";
import {
  Banner,
  Button,
  LoadingScreen,
  PageHeader,
  SelectField,
  TextField,
} from "../components/ui";
import { IconLogout } from "../components/icons";
import { useMerchant } from "./MerchantContext";
import { signOut } from "../lib/auth";
import {
  savePaymentConnection,
  updateMerchantProfile,
  updateTaxProfile,
} from "../lib/db";
import type { MerchantRow, PaymentRow, TaxRow } from "../lib/db";
import { VN_BANKS } from "../lib/banks";
import {
  FILING_FREQUENCY_OPTIONS,
  REGISTRATION_STATUS_OPTIONS,
} from "../lib/enums";
import type { FilingFrequency, RegistrationStatus } from "../lib/enums";
import {
  isValidAccountNumber,
  isValidDisplayName,
  maskAccountNumber,
  validateTaxCode,
} from "../lib/validators";

const STATUS_CHIP: Record<string, string> = {
  pending: "Chờ xác minh",
  verified: "Đã xác minh",
  failed: "Lỗi",
  revoked: "Đã thu hồi",
};

export function SettingsPage() {
  const { loading, merchant, tax, payment, email, refresh } = useMerchant();

  if (loading && !merchant) return <LoadingScreen />;
  if (!merchant)
    return (
      <div className="center-screen">
        <div className="empty__t">Chưa có cửa hàng</div>
      </div>
    );

  return (
    <div className="screen screen--tabbed">
      <PageHeader title="Cài đặt" />
      <div className="content--plain stack">
        <StoreSection merchant={merchant} onSaved={refresh} />
        <TaxSection tax={tax} onSaved={refresh} />
        <PaymentSection
          merchantId={merchant.id}
          payment={payment}
          onSaved={refresh}
        />
        <AccountSection email={email} />
      </div>
    </div>
  );
}

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card">
      <div className="section-title" style={{ margin: "0 0 12px" }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function SaveButton({
  onSave,
  disabled,
  saved,
  error,
}: {
  onSave: () => Promise<void>;
  disabled?: boolean;
  saved: boolean;
  error: string | null;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <>
      {error && <Banner kind="error">{error}</Banner>}
      {saved && <Banner kind="info">Đã lưu thay đổi.</Banner>}
      <Button
        variant="outline"
        loading={busy}
        disabled={disabled}
        onClick={async () => {
          setBusy(true);
          try {
            await onSave();
          } finally {
            setBusy(false);
          }
        }}
      >
        Lưu
      </Button>
    </>
  );
}

// ── Store profile ────────────────────────────────────────────────────────────
function StoreSection({
  merchant,
  onSaved,
}: {
  merchant: MerchantRow;
  onSaved: () => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(merchant.display_name);
  const [legalName, setLegalName] = useState(merchant.legal_name ?? "");
  const [taxCode, setTaxCode] = useState(merchant.tax_code_normalized ?? "");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tax = validateTaxCode(taxCode);
  const valid = isValidDisplayName(displayName) && tax.valid;

  return (
    <SectionCard title="Hồ sơ cửa hàng">
      <TextField
        label="Tên cửa hàng"
        value={displayName}
        onChange={(v) => {
          setDisplayName(v);
          setSaved(false);
        }}
        required
        maxLength={120}
      />
      <TextField
        label="Tên pháp lý"
        value={legalName}
        onChange={(v) => {
          setLegalName(v);
          setSaved(false);
        }}
        optional
        maxLength={200}
      />
      <TextField
        label="Mã số thuế"
        value={taxCode}
        onChange={(v) => {
          setTaxCode(v);
          setSaved(false);
        }}
        optional
        inputMode="numeric"
        error={taxCode && !tax.valid ? tax.error : null}
      />
      <SaveButton
        saved={saved}
        error={error}
        disabled={!valid}
        onSave={async () => {
          setError(null);
          try {
            await updateMerchantProfile(merchant.id, {
              displayName,
              legalName,
              taxCode,
            });
            await onSaved();
            setSaved(true);
          } catch (e) {
            setError((e as Error).message || "Không lưu được. Thử lại.");
          }
        }}
      />
    </SectionCard>
  );
}

// ── Tax profile ──────────────────────────────────────────────────────────────
function TaxSection({
  tax,
  onSaved,
}: {
  tax: TaxRow | null;
  onSaved: () => Promise<void>;
}) {
  const [reg, setReg] = useState<RegistrationStatus | "">(
    tax?.registration_status ?? "",
  );
  const [freq, setFreq] = useState<FilingFrequency | "">(
    tax?.filing_frequency ?? "",
  );
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!tax) {
    return (
      <SectionCard title="Hồ sơ thuế">
        <p className="muted">Chưa có hồ sơ thuế.</p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Hồ sơ thuế">
      <SelectField
        label="Tình trạng đăng ký"
        value={reg}
        onChange={(v) => {
          setReg(v as RegistrationStatus);
          setSaved(false);
        }}
        options={REGISTRATION_STATUS_OPTIONS.map((o) => ({
          value: o.value,
          label: o.label,
        }))}
        required
      />
      <SelectField
        label="Kỳ kê khai"
        value={freq}
        onChange={(v) => {
          setFreq(v as FilingFrequency);
          setSaved(false);
        }}
        options={FILING_FREQUENCY_OPTIONS.map((o) => ({
          value: o.value,
          label: o.label,
        }))}
        required
      />
      <SaveButton
        saved={saved}
        error={error}
        disabled={!reg || !freq}
        onSave={async () => {
          setError(null);
          try {
            await updateTaxProfile(tax.id, {
              registrationStatus: reg as RegistrationStatus,
              filingFrequency: freq as FilingFrequency,
            });
            await onSaved();
            setSaved(true);
          } catch (e) {
            setError((e as Error).message || "Không lưu được. Thử lại.");
          }
        }}
      />
    </SectionCard>
  );
}

// ── Payment connection ───────────────────────────────────────────────────────
function PaymentSection({
  merchantId,
  payment,
  onSaved,
}: {
  merchantId: string;
  payment: PaymentRow | null;
  onSaved: () => Promise<void>;
}) {
  const [bankCode, setBankCode] = useState(payment?.bank_code ?? "");
  const [accountName, setAccountName] = useState(payment?.account_name ?? "");
  const [rawAccount, setRawAccount] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasMasked = !!payment?.account_masked;
  const accountOk = rawAccount ? isValidAccountNumber(rawAccount) : hasMasked;
  const preview = rawAccount ? maskAccountNumber(rawAccount) : payment?.account_masked ?? "";
  const valid = !!bankCode && accountName.trim().length > 0 && accountOk;

  return (
    <SectionCard title="Nhận tiền QR">
      {payment && (
        <div className="row-between" style={{ marginBottom: 12 }}>
          <span className="muted tiny">Trạng thái kết nối</span>
          <span
            className={`chip ${
              payment.status === "verified" ? "chip--good" : "chip--amber"
            }`}
          >
            {STATUS_CHIP[payment.status] ?? payment.status}
          </span>
        </div>
      )}
      <SelectField
        label="Ngân hàng"
        value={bankCode}
        onChange={(v) => {
          setBankCode(v);
          setSaved(false);
        }}
        options={VN_BANKS.map((b) => ({ value: b.code, label: b.name }))}
        placeholder="Chọn ngân hàng"
        required
      />
      <TextField
        label="Tên chủ tài khoản"
        value={accountName}
        onChange={(v) => {
          setAccountName(v);
          setSaved(false);
        }}
        required
      />
      <TextField
        label="Số tài khoản"
        value={rawAccount}
        onChange={(v) => {
          setRawAccount(v);
          setSaved(false);
        }}
        inputMode="numeric"
        placeholder={
          hasMasked
            ? `Đang lưu ${payment?.account_masked} — nhập lại để đổi`
            : "Nhập số tài khoản"
        }
        error={rawAccount && !accountOk ? "Số tài khoản chưa hợp lệ." : null}
        hint={preview ? `Chỉ lưu dạng che: ${preview}` : undefined}
      />
      <SaveButton
        saved={saved}
        error={error}
        disabled={!valid}
        onSave={async () => {
          setError(null);
          try {
            const accountMasked = rawAccount
              ? maskAccountNumber(rawAccount)
              : payment?.account_masked ?? "";
            await savePaymentConnection(merchantId, payment, {
              bankCode,
              accountName,
              accountMasked,
            });
            await onSaved();
            setSaved(true);
            setRawAccount("");
          } catch (e) {
            setError((e as Error).message || "Không lưu được. Thử lại.");
          }
        }}
      />
    </SectionCard>
  );
}

// ── Account / sign out ───────────────────────────────────────────────────────
function AccountSection({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <SectionCard title="Tài khoản">
      <div className="row-between" style={{ marginBottom: 14 }}>
        <span className="muted">Email</span>
        <span style={{ fontWeight: 600, color: "var(--ink)" }}>{email}</span>
      </div>
      <Button
        variant="danger"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          await signOut();
          // App's auth listener routes back to onboarding on sign-out.
        }}
      >
        <IconLogout size={18} /> Đăng xuất
      </Button>
    </SectionCard>
  );
}
