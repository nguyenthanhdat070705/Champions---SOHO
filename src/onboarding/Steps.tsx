import { useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  Banner,
  Button,
  CheckRow,
  OptionCard,
  SelectField,
  StepShell,
  TextField,
} from "../components/ui";
import {
  IconChart,
  IconReceipt,
  IconShield,
  IconWallet,
} from "../components/icons";
import {
  BUSINESS_MODELS,
  BUSINESS_MODEL_LABELS,
  FILING_FREQUENCY_LABELS,
  FILING_FREQUENCY_OPTIONS,
  REGISTRATION_STATUS_LABELS,
  REGISTRATION_STATUS_OPTIONS,
} from "../lib/enums";
import type { BusinessModel } from "../lib/enums";
import { VN_BANKS, BANK_NAME_BY_CODE } from "../lib/banks";
import type { OnboardingData } from "../lib/types";
import { TOTAL_STEPS } from "../lib/types";
import {
  isValidAccountNumber,
  isValidDisplayName,
  isValidFullName,
  isStepComplete,
  maskAccountNumber,
  validateTaxCode,
} from "../lib/validators";
import { signInEmail, signUpEmail } from "../lib/auth";

type Upd = (patch: Partial<OnboardingData>) => void;

// ── Step 1 — Welcome & consent ───────────────────────────────────────────────
export function Step1Welcome({
  data,
  update,
  onNext,
  onSignIn,
}: {
  data: OnboardingData;
  update: Upd;
  onNext: () => void;
  onSignIn: () => void;
}) {
  const c = data.consents;
  const canStart = c.terms && c.privacy;
  return (
    <StepShell
      step={1}
      total={TOTAL_STEPS}
      footer={
        <>
          <Button
            onClick={onNext}
            disabled={!canStart}
            disabledReason="Cần đồng ý điều khoản và chính sách để bắt đầu."
          >
            Bắt đầu
          </Button>
          <Button variant="ghost" onClick={onSignIn}>
            Tôi đã có tài khoản — Đăng nhập
          </Button>
        </>
      }
    >
      <div style={{ textAlign: "center", padding: "12px 0 6px" }}>
        <div className="brandmark">
          <span />
          <span />
          <span />
          <span />
        </div>
        <h1 className="h-title" style={{ marginTop: 18 }}>
          Chào mừng đến với SoHo
        </h1>
        <p className="h-sub">
          Thiết lập một lần để SoHo ghi nhận doanh thu, thanh toán và hỗ trợ thuế
          đúng cho cửa hàng của bạn. Mất khoảng 3–5 phút.
        </p>
      </div>

      <div style={{ margin: "18px 0 8px" }}>
        <Benefit
          icon={<IconWallet size={20} />}
          t="Nhận tiền bằng mã QR"
          d="Khách quét là tiền vào, không cần máy móc phức tạp."
        />
        <Benefit
          icon={<IconReceipt size={20} />}
          t="Tự động làm sổ thuế"
          d="Doanh thu được ghi nhận gọn gàng, sẵn sàng khi cần khai báo."
        />
        <Benefit
          icon={<IconChart size={20} />}
          t="Xem cửa hàng mỗi ngày"
          d="Biết hôm nay bán được bao nhiêu, ngay trên điện thoại."
        />
      </div>

      <div style={{ marginTop: 14 }}>
        <CheckRow
          checked={c.terms}
          onToggle={() => update({ consents: { ...c, terms: !c.terms } })}
        >
          Tôi đồng ý với <b>Điều khoản sử dụng</b> của SoHo.
        </CheckRow>
        <CheckRow
          checked={c.privacy}
          onToggle={() => update({ consents: { ...c, privacy: !c.privacy } })}
        >
          Tôi đồng ý với <b>Chính sách dữ liệu</b> của SoHo.
        </CheckRow>
        <CheckRow
          checked={c.marketing}
          onToggle={() =>
            update({ consents: { ...c, marketing: !c.marketing } })
          }
        >
          Nhận thông tin ưu đãi và mẹo kinh doanh từ SoHo.{" "}
          <span className="muted">(không bắt buộc)</span>
        </CheckRow>
      </div>
      <p className="tiny muted" style={{ marginTop: 4 }}>
        Bạn cần đồng ý Điều khoản và Chính sách dữ liệu để tiếp tục.
      </p>
    </StepShell>
  );
}

function Benefit({ icon, t, d }: { icon: React.ReactNode; t: string; d: string }) {
  return (
    <div className="benefit">
      <div className="benefit__ic">{icon}</div>
      <div>
        <div className="benefit__t">{t}</div>
        <div className="benefit__d">{d}</div>
      </div>
    </div>
  );
}

// ── Step 2 — Auth (email + password) ─────────────────────────────────────────
export function Step2Auth({
  initialMode,
  fullNameHint,
  onBack,
  onAuthenticated,
}: {
  initialMode: "signup" | "signin";
  fullNameHint: string;
  onBack: () => void;
  onAuthenticated: (session: Session) => void;
}) {
  const [mode, setMode] = useState<"signup" | "signin">(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const res =
        mode === "signup"
          ? await signUpEmail(email, password, fullNameHint)
          : await signInEmail(email, password);

      if (!res.ok) {
        if (res.alreadyExists) setMode("signin");
        setError(res.error);
        return;
      }
      if (res.needsConfirmation || !res.session) {
        setSentTo(email.trim().toLowerCase());
        return;
      }
      onAuthenticated(res.session);
    } catch (e) {
      setError((e as Error).message || "Có lỗi xảy ra, vui lòng thử lại.");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = email.includes("@") && password.length >= 6 && !busy;

  if (sentTo) {
    return (
      <StepShell
        step={2}
        total={TOTAL_STEPS}
        onBack={() => setSentTo(null)}
        footer={
          <Button
            onClick={() => {
              setMode("signin");
              setSentTo(null);
            }}
          >
            Tôi đã xác nhận — Đăng nhập
          </Button>
        }
      >
        <h1 className="h-title" style={{ marginTop: 8 }}>
          Kiểm tra email của bạn
        </h1>
        <p className="h-sub">
          Chúng tôi đã gửi một email xác nhận tới <b>{sentTo}</b>. Vui lòng mở
          email, bấm nút xác nhận, rồi quay lại đây để đăng nhập.
        </p>
        <Banner kind="info">
          Chưa nhận được email? Kiểm tra mục spam, hoặc thử lại sau ít phút.
        </Banner>
      </StepShell>
    );
  }

  return (
    <StepShell
      step={2}
      total={TOTAL_STEPS}
      onBack={onBack}
      footer={
        <>
          <Button
            onClick={submit}
            disabled={!canSubmit}
            loading={busy}
            disabledReason="Nhập email và mật khẩu hợp lệ (tối thiểu 6 ký tự) để tiếp tục."
          >
            {mode === "signup" ? "Tạo tài khoản" : "Đăng nhập"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setError(null);
              setMode(mode === "signup" ? "signin" : "signup");
            }}
          >
            {mode === "signup"
              ? "Đã có tài khoản? Đăng nhập"
              : "Chưa có tài khoản? Đăng ký"}
          </Button>
        </>
      }
    >
      <h1 className="h-title" style={{ marginTop: 8 }}>
        {mode === "signup" ? "Tạo tài khoản SoHo" : "Đăng nhập SoHo"}
      </h1>
      <p className="h-sub">Đăng nhập bằng Email + Mật khẩu.</p>

      {error && <Banner kind="error">{error}</Banner>}

      <div style={{ marginTop: 12 }}>
        <TextField
          label="Email"
          value={email}
          onChange={setEmail}
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="ban@vidu.com"
        />
        <TextField
          label="Mật khẩu"
          value={password}
          onChange={setPassword}
          type="password"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          placeholder="Ít nhất 6 ký tự"
          hint={mode === "signup" ? "Mật khẩu cần ít nhất 6 ký tự." : undefined}
        />
      </div>

      <Banner kind="info">
        SoHo sẽ hỗ trợ đăng nhập bằng số điện thoại khi có nhà cung cấp SMS. Hiện
        tại bạn dùng email và mật khẩu.
      </Banner>
    </StepShell>
  );
}

// ── Step 3 — Manager ─────────────────────────────────────────────────────────
export function Step3Manager({
  data,
  update,
  email,
  onNext,
  onBack,
}: {
  data: OnboardingData;
  update: Upd;
  email: string;
  onNext: () => void;
  onBack: () => void;
}) {
  const [touched, setTouched] = useState(false);
  const valid = isValidFullName(data.fullName);
  return (
    <StepShell
      step={3}
      total={TOTAL_STEPS}
      onBack={onBack}
      footer={
        <Button
          onClick={() => (valid ? onNext() : setTouched(true))}
          disabled={!valid}
          disabledReason="Cần nhập họ tên để tiếp tục."
        >
          Tiếp tục
        </Button>
      }
    >
      <h1 className="h-title" style={{ marginTop: 8 }}>
        Người quản lý cửa hàng
      </h1>
      <p className="h-sub">Cho SoHo biết tên của bạn để xưng hô cho thân mật.</p>

      <div style={{ marginTop: 16 }}>
        <TextField
          label="Họ và tên"
          value={data.fullName}
          onChange={(v) => update({ fullName: v })}
          placeholder="Ví dụ: Nguyễn Thị Lan"
          required
          maxLength={120}
          error={
            touched && !valid ? "Vui lòng nhập họ tên (1–120 ký tự)." : null
          }
        />
        <TextField
          label="Email đăng nhập"
          value={email}
          onChange={() => {}}
          disabled
          hint="Đây là email bạn vừa dùng để đăng nhập."
        />
      </div>
    </StepShell>
  );
}

// ── Step 4 — Business model ──────────────────────────────────────────────────
export function Step4BusinessModel({
  data,
  update,
  onNext,
  onBack,
}: {
  data: OnboardingData;
  update: Upd;
  onNext: () => void;
  onBack: () => void;
}) {
  return (
    <StepShell
      step={4}
      total={TOTAL_STEPS}
      onBack={onBack}
      footer={
        <Button
          onClick={onNext}
          disabled={data.businessModel === null}
          disabledReason="Chọn loại hình kinh doanh để tiếp tục."
        >
          Tiếp tục
        </Button>
      }
    >
      <h1 className="h-title" style={{ marginTop: 8 }}>
        Cửa hàng của bạn bán gì?
      </h1>
      <p className="h-sub">
        Chọn loại gần nhất. SoHo dùng thông tin này để gợi ý phù hợp — không phải
        phân loại pháp lý.
      </p>

      <div style={{ marginTop: 16 }}>
        {BUSINESS_MODELS.map((m) => (
          <OptionCard
            key={m.value}
            icon={<span style={{ fontSize: 24 }}>{m.icon}</span>}
            label={m.label}
            hint={m.examples}
            selected={data.businessModel === m.value}
            onSelect={() => update({ businessModel: m.value as BusinessModel })}
          />
        ))}
      </div>
    </StepShell>
  );
}

// ── Step 5 — Store profile ───────────────────────────────────────────────────
export function Step5StoreProfile({
  data,
  update,
  onNext,
  onBack,
}: {
  data: OnboardingData;
  update: Upd;
  onNext: () => void;
  onBack: () => void;
}) {
  const [touched, setTouched] = useState(false);
  const tax = validateTaxCode(data.taxCode);
  const nameOk = isValidDisplayName(data.displayName);
  const addrOk = data.addressLine.trim().length > 0;
  const canNext = isStepComplete(5, data);
  return (
    <StepShell
      step={5}
      total={TOTAL_STEPS}
      onBack={onBack}
      footer={
        <Button
          onClick={() => (canNext ? onNext() : setTouched(true))}
          disabled={!canNext}
          disabledReason={
            !nameOk
              ? "Cần nhập tên cửa hàng để tiếp tục."
              : !addrOk
                ? "Cần điền địa chỉ để tiếp tục."
                : !tax.valid
                  ? "Mã số thuế phải có 10 hoặc 13 chữ số."
                  : undefined
          }
        >
          Tiếp tục
        </Button>
      }
    >
      <h1 className="h-title" style={{ marginTop: 8 }}>
        Hồ sơ hộ kinh doanh
      </h1>
      <p className="h-sub">
        Tên hiển thị là bắt buộc. Những mục khác có thể để trống nếu bạn chưa có.
      </p>

      <div style={{ marginTop: 16 }}>
        <TextField
          label="Tên cửa hàng (hiển thị)"
          value={data.displayName}
          onChange={(v) => update({ displayName: v })}
          placeholder="Ví dụ: Tạp hóa Lan Anh"
          required
          maxLength={120}
          error={touched && !nameOk ? "Vui lòng nhập tên cửa hàng." : null}
        />
        <TextField
          label="Tên pháp lý"
          value={data.legalName}
          onChange={(v) => update({ legalName: v })}
          placeholder="Tên trên giấy phép (nếu có)"
          optional
          maxLength={200}
        />
        <TextField
          label="Mã số thuế"
          value={data.taxCode}
          onChange={(v) => update({ taxCode: v })}
          placeholder="10 hoặc 13 chữ số (nếu có)"
          optional
          inputMode="numeric"
          error={touched && !tax.valid ? tax.error : null}
          hint={
            !touched || tax.valid
              ? "Để trống nếu bạn chưa đăng ký hoặc chưa có mã số thuế."
              : undefined
          }
        />
        <TextField
          label="Địa chỉ (số nhà, đường)"
          value={data.addressLine}
          onChange={(v) => update({ addressLine: v })}
          placeholder="Ví dụ: 12 Nguyễn Trãi"
          required
          maxLength={250}
          error={touched && !addrOk ? "Vui lòng nhập địa chỉ cửa hàng." : null}
        />
        <TextField
          label="Tỉnh / Thành phố"
          value={data.provinceText}
          onChange={(v) => update({ provinceText: v })}
          placeholder="Ví dụ: TP. Hồ Chí Minh"
          optional
        />
        <TextField
          label="Phường / Xã"
          value={data.wardText}
          onChange={(v) => update({ wardText: v })}
          placeholder="Ví dụ: Phường Bến Thành"
          optional
        />
      </div>
    </StepShell>
  );
}

// ── Step 6 — Tax setup ───────────────────────────────────────────────────────
export function Step6Tax({
  data,
  update,
  onNext,
  onBack,
}: {
  data: OnboardingData;
  update: Upd;
  onNext: () => void;
  onBack: () => void;
}) {
  const canNext = isStepComplete(6, data);
  return (
    <StepShell
      step={6}
      total={TOTAL_STEPS}
      onBack={onBack}
      footer={
        <Button
          onClick={onNext}
          disabled={!canNext}
          disabledReason="Chọn tình trạng đăng ký và kỳ khai thuế để tiếp tục."
        >
          Tiếp tục
        </Button>
      }
    >
      <h1 className="h-title" style={{ marginTop: 8 }}>
        Thiết lập thuế
      </h1>
      <p className="h-sub">
        Không sao nếu bạn chưa rõ. Cứ chọn “Tôi chưa rõ” — SoHo sẽ hướng dẫn bạn
        sau, và không tự kết luận nghĩa vụ thuế khi chưa đủ thông tin.
      </p>

      <div className="section-title" style={{ marginTop: 18 }}>
        Cửa hàng đã đăng ký kinh doanh chưa?
      </div>
      {REGISTRATION_STATUS_OPTIONS.map((o) => (
        <OptionCard
          key={o.value}
          icon={<IconShield size={20} />}
          label={o.label}
          hint={o.hint}
          selected={data.registrationStatus === o.value}
          onSelect={() => update({ registrationStatus: o.value })}
        />
      ))}

      <div className="section-title">Bạn kê khai thuế theo kỳ nào?</div>
      {FILING_FREQUENCY_OPTIONS.map((o) => (
        <OptionCard
          key={o.value}
          icon={<IconReceipt size={20} />}
          label={o.label}
          hint={o.hint}
          selected={data.filingFrequency === o.value}
          onSelect={() => update({ filingFrequency: o.value })}
        />
      ))}
    </StepShell>
  );
}

// ── Step 7 — QR payment connection ───────────────────────────────────────────
export function Step7Payment({
  data,
  update,
  onNext,
  onBack,
}: {
  data: OnboardingData;
  update: Upd;
  onNext: () => void;
  onBack: () => void;
}) {
  const [rawAccount, setRawAccount] = useState("");
  const [touched, setTouched] = useState(false);
  const p = data.payment;

  const hasExistingMasked = p.accountMasked.length > 0;
  const accountValid = rawAccount
    ? isValidAccountNumber(rawAccount)
    : hasExistingMasked;
  const preview = rawAccount ? maskAccountNumber(rawAccount) : p.accountMasked;
  const canSave =
    p.bankCode.length > 0 && p.accountName.trim().length > 0 && accountValid;

  function saveAndNext() {
    if (!canSave) {
      setTouched(true);
      return;
    }
    const masked = rawAccount ? maskAccountNumber(rawAccount) : p.accountMasked;
    update({
      payment: { ...p, skipped: false, accountMasked: masked },
    });
    onNext();
  }

  function skip() {
    update({
      payment: {
        skipped: true,
        bankCode: "",
        accountName: "",
        accountMasked: "",
      },
    });
    onNext();
  }

  return (
    <StepShell
      step={7}
      total={TOTAL_STEPS}
      onBack={onBack}
      footer={
        <>
          <Button onClick={saveAndNext}>Lưu &amp; tiếp tục</Button>
          <Button variant="ghost" onClick={skip}>
            Để sau
          </Button>
        </>
      }
    >
      <h1 className="h-title" style={{ marginTop: 8 }}>
        Kết nối nhận tiền QR
      </h1>
      <p className="h-sub">
        Nhập tài khoản ngân hàng để khách quét QR trả tiền. Bạn có thể làm sau
        cũng được.
      </p>

      <div style={{ marginTop: 16 }}>
        <SelectField
          label="Ngân hàng nhận tiền"
          value={p.bankCode}
          onChange={(v) => update({ payment: { ...p, bankCode: v } })}
          options={VN_BANKS.map((b) => ({ value: b.code, label: b.name }))}
          placeholder="Chọn ngân hàng"
          required
        />
        <TextField
          label="Tên chủ tài khoản"
          value={p.accountName}
          onChange={(v) => update({ payment: { ...p, accountName: v } })}
          placeholder="VD: NGUYEN THI LAN"
          required
          error={
            touched && p.accountName.trim().length === 0
              ? "Vui lòng nhập tên chủ tài khoản."
              : null
          }
        />
        <TextField
          label="Số tài khoản"
          value={rawAccount}
          onChange={setRawAccount}
          placeholder={
            hasExistingMasked
              ? `Đang lưu ${p.accountMasked} — nhập lại để thay đổi`
              : "Nhập số tài khoản"
          }
          required={!hasExistingMasked}
          inputMode="numeric"
          error={touched && !accountValid ? "Số tài khoản chưa hợp lệ." : null}
          hint={
            preview
              ? `SoHo chỉ lưu dạng che: ${preview} — không lưu số đầy đủ.`
              : "Vì an toàn, SoHo chỉ lưu 4 số cuối của tài khoản."
          }
        />
      </div>

      <Banner kind="info">
        Kết nối sẽ ở trạng thái “chờ xác minh”. Bạn vẫn vào được cửa hàng và nhận
        tiền mặt bình thường.
      </Banner>
    </StepShell>
  );
}

// ── Step 8 — Review & finish ─────────────────────────────────────────────────
export function Step8Review({
  data,
  email,
  busy,
  error,
  onEdit,
  onBack,
  onFinish,
}: {
  data: OnboardingData;
  email: string;
  busy: boolean;
  error: string | null;
  onEdit: (step: number) => void;
  onBack: () => void;
  onFinish: () => void;
}) {
  const bm = data.businessModel
    ? BUSINESS_MODEL_LABELS[data.businessModel]
    : "—";
  const tax = validateTaxCode(data.taxCode);
  return (
    <StepShell
      step={8}
      total={TOTAL_STEPS}
      onBack={onBack}
      footer={
        <Button onClick={onFinish} loading={busy}>
          Hoàn tất &amp; mở cửa hàng
        </Button>
      }
    >
      <h1 className="h-title" style={{ marginTop: 8 }}>
        Kiểm tra lại
      </h1>
      <p className="h-sub">Xem nhanh thông tin trước khi tạo cửa hàng.</p>

      {error && <Banner kind="error">{error}</Banner>}

      <div style={{ marginTop: 8 }}>
        <SummaryGroup title="Người quản lý" onEdit={() => onEdit(3)}>
          <Row k="Họ tên" v={data.fullName || "—"} />
          <Row k="Email" v={email} />
        </SummaryGroup>

        <SummaryGroup title="Loại hình" onEdit={() => onEdit(4)}>
          <Row k="Kinh doanh" v={bm} />
        </SummaryGroup>

        <SummaryGroup title="Hồ sơ cửa hàng" onEdit={() => onEdit(5)}>
          <Row k="Tên cửa hàng" v={data.displayName || "—"} />
          {data.legalName && <Row k="Tên pháp lý" v={data.legalName} />}
          <Row
            k="Mã số thuế"
            v={tax.normalized ? tax.normalized : "Chưa có"}
          />
          <Row
            k="Địa chỉ"
            v={[data.addressLine, data.wardText, data.provinceText]
              .filter(Boolean)
              .join(", ")}
          />
        </SummaryGroup>

        <SummaryGroup title="Thuế" onEdit={() => onEdit(6)}>
          <Row
            k="Tình trạng"
            v={
              data.registrationStatus
                ? REGISTRATION_STATUS_LABELS[data.registrationStatus]
                : "—"
            }
          />
          <Row
            k="Kỳ kê khai"
            v={
              data.filingFrequency
                ? FILING_FREQUENCY_LABELS[data.filingFrequency]
                : "—"
            }
          />
        </SummaryGroup>

        <SummaryGroup title="Nhận tiền QR" onEdit={() => onEdit(7)}>
          {data.payment.skipped ? (
            <Row k="Trạng thái" v="Sẽ kết nối sau" />
          ) : (
            <>
              <Row
                k="Ngân hàng"
                v={BANK_NAME_BY_CODE[data.payment.bankCode] || data.payment.bankCode}
              />
              <Row k="Chủ tài khoản" v={data.payment.accountName} />
              <Row k="Số tài khoản" v={data.payment.accountMasked} />
            </>
          )}
        </SummaryGroup>
      </div>
    </StepShell>
  );
}

function SummaryGroup({
  title,
  onEdit,
  children,
}: {
  title: string;
  onEdit: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="summary-group">
      <div className="summary-group__head">
        <span className="summary-group__title">{title}</span>
        <button className="edit-link" onClick={onEdit}>
          Sửa
        </button>
      </div>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="summary-row">
      <span className="summary-row__k">{k}</span>
      <span className="summary-row__v">{v}</span>
    </div>
  );
}
