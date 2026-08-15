import type { ReactNode } from "react";
import { IconBack, IconCheck } from "./icons";

// ── Button ───────────────────────────────────────────────────────────────────
type BtnVariant = "primary" | "navy" | "ghost" | "outline" | "danger";
export function Button({
  children,
  variant = "primary",
  loading = false,
  disabled,
  onClick,
  type = "button",
}: {
  children: ReactNode;
  variant?: BtnVariant;
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      className={`btn btn--${variant}`}
      disabled={disabled || loading}
      onClick={onClick}
    >
      {loading ? (
        <span
          className={`spinner spinner--sm ${
            variant === "primary" || variant === "navy" ? "spinner--light" : ""
          }`}
        />
      ) : (
        children
      )}
    </button>
  );
}

// ── Text field ───────────────────────────────────────────────────────────────
export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  error,
  required,
  optional,
  type = "text",
  inputMode,
  maxLength,
  autoComplete,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  optional?: boolean;
  type?: string;
  inputMode?: "text" | "numeric" | "email" | "tel";
  maxLength?: number;
  autoComplete?: string;
  disabled?: boolean;
}) {
  return (
    <div className="field">
      <label className="field__label">
        {label}
        {required && <span className="field__req"> *</span>}
        {optional && <span className="field__opt"> (không bắt buộc)</span>}
      </label>
      <input
        className={`input ${error ? "input--error" : ""}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        type={type}
        inputMode={inputMode}
        maxLength={maxLength}
        autoComplete={autoComplete}
        disabled={disabled}
      />
      {error ? (
        <div className="field__error">{error}</div>
      ) : hint ? (
        <div className="field__hint">{hint}</div>
      ) : null}
    </div>
  );
}

// ── Select field ─────────────────────────────────────────────────────────────
export function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder = "Chọn…",
  required,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  required?: boolean;
  hint?: string;
}) {
  return (
    <div className="field">
      <label className="field__label">
        {label}
        {required && <span className="field__req"> *</span>}
      </label>
      <select
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <div className="field__hint">{hint}</div>}
    </div>
  );
}

// ── Checkbox row ─────────────────────────────────────────────────────────────
export function CheckRow({
  checked,
  onToggle,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={`checkrow ${checked ? "checkrow--on" : ""}`}
      onClick={onToggle}
      role="checkbox"
      aria-checked={checked}
    >
      <div className="checkrow__box">
        {checked && <IconCheck size={16} color="#fff" />}
      </div>
      <div className="checkrow__text">{children}</div>
    </div>
  );
}

// ── Option card ──────────────────────────────────────────────────────────────
export function OptionCard({
  icon,
  label,
  hint,
  selected,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={`opt ${selected ? "opt--on" : ""}`}
      onClick={onSelect}
      type="button"
    >
      <span className="opt__icon">{icon}</span>
      <span className="opt__body">
        <span className="opt__label">{label}</span>
        {hint && <span className="opt__hint">{hint}</span>}
      </span>
      <span className="opt__check">
        {selected && <IconCheck size={15} color="#fff" />}
      </span>
    </button>
  );
}

// ── Onboarding step shell ────────────────────────────────────────────────────
export function StepShell({
  step,
  total,
  onBack,
  children,
  footer,
}: {
  step: number;
  total: number;
  onBack?: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="step">
      <div className="step__top">
        {onBack ? (
          <button className="step__back" onClick={onBack} aria-label="Quay lại">
            <IconBack size={20} />
          </button>
        ) : (
          <span style={{ width: 40 }} />
        )}
        <div className="dots">
          {Array.from({ length: total }, (_, i) => {
            const n = i + 1;
            const cls =
              n < step ? "dots__dot--done" : n === step ? "dots__dot--cur" : "";
            return <span key={n} className={`dots__dot ${cls}`} />;
          })}
        </div>
      </div>
      <div className="step__body">{children}</div>
      <div className="step__foot">{footer}</div>
    </div>
  );
}

// ── Sub-page header ──────────────────────────────────────────────────────────
export function PageHeader({
  title,
  onBack,
  right,
}: {
  title: string;
  onBack?: () => void;
  right?: ReactNode;
}) {
  return (
    <div className="pagehead">
      {onBack && (
        <button className="step__back" onClick={onBack} aria-label="Quay lại">
          <IconBack size={20} />
        </button>
      )}
      <div className="pagehead__title">{title}</div>
      <div className="spacer" />
      {right}
    </div>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────
export function EmptyState({
  icon,
  title,
  desc,
}: {
  icon: ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div className="empty">
      <div className="empty__ic">{icon}</div>
      <div className="empty__t">{title}</div>
      <div className="empty__d">{desc}</div>
    </div>
  );
}

// ── Banner ───────────────────────────────────────────────────────────────────
export function Banner({
  kind = "info",
  children,
}: {
  kind?: "info" | "warn" | "error";
  children: ReactNode;
}) {
  return <div className={`banner banner--${kind}`}>{children}</div>;
}

// ── Loading screen ───────────────────────────────────────────────────────────
export function LoadingScreen() {
  return (
    <div className="center-screen">
      <div className="spinner" />
    </div>
  );
}
