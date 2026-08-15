import type {
  BusinessModel,
  FilingFrequency,
  RegistrationStatus,
} from "./enums";

export interface ConsentChoices {
  terms: boolean;
  privacy: boolean;
  marketing: boolean;
}

export interface PaymentData {
  skipped: boolean;
  bankCode: string;
  accountName: string;
  // Full account number is held only transiently in the payment step's local
  // state to compute the mask; it is NEVER placed in OnboardingData / draft_data.
  accountMasked: string;
}

// The full onboarding form state. This is what we persist (minus secrets) into
// onboarding_progress.draft_data for resume. It contains NO password and NO raw
// account number — only the masked account form.
export interface OnboardingData {
  consents: ConsentChoices;
  fullName: string;
  businessModel: BusinessModel | null;
  displayName: string;
  legalName: string;
  taxCode: string;
  addressLine: string;
  provinceText: string;
  wardText: string;
  registrationStatus: RegistrationStatus | null;
  filingFrequency: FilingFrequency | null;
  payment: PaymentData;
}

export function emptyOnboardingData(): OnboardingData {
  return {
    consents: { terms: false, privacy: false, marketing: false },
    fullName: "",
    businessModel: null,
    displayName: "",
    legalName: "",
    taxCode: "",
    addressLine: "",
    provinceText: "",
    wardText: "",
    registrationStatus: null,
    filingFrequency: null,
    payment: { skipped: false, bankCode: "", accountName: "", accountMasked: "" },
  };
}

// The 8 onboarding steps. Step 1 = welcome/consent, Step 2 = auth, ... Step 8 = review.
export const TOTAL_STEPS = 8;
export type StepNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
