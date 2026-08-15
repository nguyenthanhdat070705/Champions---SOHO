import { describe, expect, it } from "vitest";
import {
  canFinishOnboarding,
  completedSteps,
  isStepComplete,
  isValidAccountNumber,
  maskAccountNumber,
  normalizeTaxCode,
  validateTaxCode,
} from "./validators";
import { emptyOnboardingData } from "./types";
import type { OnboardingData } from "./types";

describe("normalizeTaxCode", () => {
  it("strips spaces, dashes and letters, keeping digits", () => {
    expect(normalizeTaxCode("  0312-345 678 ")).toBe("0312345678");
    expect(normalizeTaxCode("MST: 0101243150-001")).toBe("0101243150001");
    expect(normalizeTaxCode("")).toBe("");
  });
});

describe("validateTaxCode", () => {
  it("treats empty as valid (optional field)", () => {
    expect(validateTaxCode("")).toEqual({
      valid: true,
      normalized: "",
      error: null,
    });
    expect(validateTaxCode("   ")).toEqual({
      valid: true,
      normalized: "",
      error: null,
    });
  });

  it("accepts exactly 10 digits", () => {
    const r = validateTaxCode("0312345678");
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe("0312345678");
    expect(r.error).toBeNull();
  });

  it("accepts exactly 13 digits (10 + 3 branch suffix)", () => {
    const r = validateTaxCode("0101243150 001");
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe("0101243150001");
  });

  it("rejects lengths other than 10 or 13", () => {
    for (const bad of ["123", "123456789", "01234567890", "01012431500011"]) {
      const r = validateTaxCode(bad);
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/10 hoặc 13/);
    }
  });
});

describe("maskAccountNumber", () => {
  it("keeps the last 4 digits behind a fixed 6-asterisk prefix", () => {
    expect(maskAccountNumber("123456789")).toBe("******6789");
    expect(maskAccountNumber("1900123456789")).toBe("******6789");
    expect(maskAccountNumber("0071000123456")).toBe("******3456");
  });

  it("ignores spaces and separators", () => {
    expect(maskAccountNumber("0071 0001 2345 6")).toBe("******3456");
  });

  it("returns empty string when there are no digits", () => {
    expect(maskAccountNumber("")).toBe("");
    expect(maskAccountNumber("abc")).toBe("");
  });

  it("never contains any of the original leading digits", () => {
    const raw = "9876543210";
    const masked = maskAccountNumber(raw);
    expect(masked).toBe("******3210");
    // Only the last 4 digits survive; the first 6 must be gone.
    expect(masked.includes("987654")).toBe(false);
  });
});

describe("isValidAccountNumber", () => {
  it("accepts 6–19 digit numbers", () => {
    expect(isValidAccountNumber("123456")).toBe(true);
    expect(isValidAccountNumber("1900 1234 5678")).toBe(true);
  });
  it("rejects too-short / too-long", () => {
    expect(isValidAccountNumber("12345")).toBe(false);
    expect(isValidAccountNumber("12345678901234567890")).toBe(false);
    expect(isValidAccountNumber("")).toBe(false);
  });
});

// ── Step completeness ────────────────────────────────────────────────────────

function fullyValidData(): OnboardingData {
  return {
    ...emptyOnboardingData(),
    consents: { terms: true, privacy: true, marketing: false },
    fullName: "Nguyễn Thị Lan",
    businessModel: "retail",
    displayName: "Tạp hóa Lan Anh",
    legalName: "",
    taxCode: "0312345678",
    addressLine: "12 Nguyễn Trãi",
    provinceText: "TP. Hồ Chí Minh",
    wardText: "Phường Bến Thành",
    registrationStatus: "registered",
    filingFrequency: "unknown",
    payment: {
      skipped: false,
      bankCode: "VCB",
      accountName: "NGUYEN THI LAN",
      accountMasked: "******6789",
    },
  };
}

describe("isStepComplete", () => {
  it("step 1 needs both required consents (marketing irrelevant)", () => {
    const d = emptyOnboardingData();
    expect(isStepComplete(1, d)).toBe(false);
    d.consents.terms = true;
    expect(isStepComplete(1, d)).toBe(false);
    d.consents.privacy = true;
    expect(isStepComplete(1, d)).toBe(true);
    d.consents.marketing = true;
    expect(isStepComplete(1, d)).toBe(true);
  });

  it("step 3 needs a full name within 1–120 chars", () => {
    const d = emptyOnboardingData();
    expect(isStepComplete(3, d)).toBe(false);
    d.fullName = "  ";
    expect(isStepComplete(3, d)).toBe(false);
    d.fullName = "Lan";
    expect(isStepComplete(3, d)).toBe(true);
    d.fullName = "x".repeat(121);
    expect(isStepComplete(3, d)).toBe(false);
  });

  it("step 4 needs a business model", () => {
    const d = emptyOnboardingData();
    expect(isStepComplete(4, d)).toBe(false);
    d.businessModel = "food_beverage";
    expect(isStepComplete(4, d)).toBe(true);
  });

  it("step 5 needs display name + address; tax code optional but must be valid if present", () => {
    const d = fullyValidData();
    expect(isStepComplete(5, d)).toBe(true);
    d.taxCode = "";
    expect(isStepComplete(5, d)).toBe(true); // optional
    d.taxCode = "123"; // present but invalid
    expect(isStepComplete(5, d)).toBe(false);
    d.taxCode = "0312345678";
    d.displayName = "   ";
    expect(isStepComplete(5, d)).toBe(false);
    d.displayName = "Cửa hàng";
    d.addressLine = "";
    expect(isStepComplete(5, d)).toBe(false);
  });

  it("step 6 needs both tax answers (unknown counts as answered)", () => {
    const d = emptyOnboardingData();
    expect(isStepComplete(6, d)).toBe(false);
    d.registrationStatus = "unknown";
    expect(isStepComplete(6, d)).toBe(false);
    d.filingFrequency = "unknown";
    expect(isStepComplete(6, d)).toBe(true);
  });

  it("step 7 is complete when skipped, or when bank+name+masked present", () => {
    const d = emptyOnboardingData();
    expect(isStepComplete(7, d)).toBe(false);
    d.payment.skipped = true;
    expect(isStepComplete(7, d)).toBe(true);
    d.payment.skipped = false;
    d.payment.bankCode = "VCB";
    d.payment.accountName = "NGUYEN VAN A";
    expect(isStepComplete(7, d)).toBe(false); // no masked yet
    d.payment.accountMasked = "******6789";
    expect(isStepComplete(7, d)).toBe(true);
  });
});

describe("completedSteps / canFinishOnboarding", () => {
  it("reports all data steps complete for fully valid data", () => {
    const d = fullyValidData();
    expect(completedSteps(d)).toEqual([1, 3, 4, 5, 6, 7]);
    expect(canFinishOnboarding(d)).toBe(true);
  });

  it("cannot finish when a required step is missing", () => {
    const d = fullyValidData();
    d.businessModel = null;
    expect(canFinishOnboarding(d)).toBe(false);
    expect(completedSteps(d)).not.toContain(4);
  });

  it("empty data cannot finish", () => {
    expect(canFinishOnboarding(emptyOnboardingData())).toBe(false);
  });
});
