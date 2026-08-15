// Pure validation / normalization helpers. No side effects, fully unit-tested.

import type { OnboardingData } from "./types";

// ── Tax code (mã số thuế) ────────────────────────────────────────────────────

/** Strip everything except digits. */
export function normalizeTaxCode(raw: string): string {
  return (raw ?? "").replace(/\D/g, "");
}

export interface TaxCodeResult {
  valid: boolean;
  normalized: string;
  /** Vietnamese error message, or null when valid. */
  error: string | null;
}

/**
 * Tax code is OPTIONAL. When empty → valid. When present, the normalized digits
 * must be exactly 10 or 13 (matches the DB constraint ^[0-9]{10}([0-9]{3})?$).
 */
export function validateTaxCode(raw: string): TaxCodeResult {
  const normalized = normalizeTaxCode(raw);
  if (normalized.length === 0) {
    return { valid: true, normalized: "", error: null };
  }
  if (normalized.length === 10 || normalized.length === 13) {
    return { valid: true, normalized, error: null };
  }
  return {
    valid: false,
    normalized,
    error: "Mã số thuế phải có 10 hoặc 13 chữ số",
  };
}

// ── Account number masking ───────────────────────────────────────────────────

/**
 * Mask a bank account number for storage. We keep only the last 4 digits behind
 * a fixed 6-asterisk prefix, e.g. "1900123456789" → "******6789". The full
 * number is never stored — only this masked form goes into account_masked.
 * Returns "" for input with no digits.
 */
export function maskAccountNumber(raw: string): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 0) return "";
  const last4 = digits.slice(-4);
  return "******" + last4;
}

/** A bank account number is valid when it has 6–19 digits (typical VN range). */
export function isValidAccountNumber(raw: string): boolean {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length >= 6 && digits.length <= 19;
}

// ── Simple field validators ──────────────────────────────────────────────────

export function isValidFullName(raw: string): boolean {
  const trimmed = (raw ?? "").trim();
  return trimmed.length >= 1 && trimmed.length <= 120;
}

export function isValidDisplayName(raw: string): boolean {
  const trimmed = (raw ?? "").trim();
  return trimmed.length >= 1 && trimmed.length <= 120;
}

export function isValidAddressLine(raw: string): boolean {
  const trimmed = (raw ?? "").trim();
  return trimmed.length >= 1 && trimmed.length <= 250;
}

export function isValidEmail(raw: string): boolean {
  const value = (raw ?? "").trim();
  // Pragmatic email shape check for client-side UX (not a security boundary).
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function isValidPassword(raw: string): boolean {
  return (raw ?? "").length >= 6;
}

// ── Per-step completeness (drives Next-button + review + resume) ─────────────

/**
 * Whether a given onboarding step has enough valid data to move on. Step 2
 * (auth) is handled by the auth session, not by this form-completeness check,
 * so callers gate it on the presence of a session instead.
 */
export function isStepComplete(step: number, data: OnboardingData): boolean {
  switch (step) {
    case 1:
      return data.consents.terms && data.consents.privacy;
    case 2:
      // Auth completeness is determined by an active session, not form data.
      return true;
    case 3:
      return isValidFullName(data.fullName);
    case 4:
      return data.businessModel !== null;
    case 5:
      return (
        isValidDisplayName(data.displayName) &&
        isValidAddressLine(data.addressLine) &&
        validateTaxCode(data.taxCode).valid
      );
    case 6:
      return data.registrationStatus !== null && data.filingFrequency !== null;
    case 7:
      if (data.payment.skipped) return true;
      return (
        data.payment.bankCode.length > 0 &&
        data.payment.accountName.trim().length > 0 &&
        data.payment.accountMasked.length > 0
      );
    case 8:
      return true;
    default:
      return false;
  }
}

/**
 * The data-collection steps that are complete, used to build completed_steps.
 * Step 2 (auth) is excluded because its completeness is session-derived, not
 * derived from the form data this function sees.
 */
export const DATA_STEPS = [1, 3, 4, 5, 6, 7] as const;

export function completedSteps(data: OnboardingData): number[] {
  return DATA_STEPS.filter((step) => isStepComplete(step, data));
}

/** All the data steps required before the merchant can be created. */
export function canFinishOnboarding(data: OnboardingData): boolean {
  return DATA_STEPS.every((step) => isStepComplete(step, data));
}
