// Database enum values (must match the deployed Supabase schema exactly) plus
// the plain-language Vietnamese labels shown in the UI.

export type BusinessModel = "retail" | "food_beverage" | "service" | "mixed";

export const BUSINESS_MODELS: {
  value: BusinessModel;
  label: string;
  examples: string;
  icon: string;
}[] = [
  { value: "retail", label: "Bán lẻ", examples: "Tạp hóa, mỹ phẩm, quần áo", icon: "🛍️" },
  { value: "food_beverage", label: "Ăn uống (F&B)", examples: "Quán nước, đồ ăn, cà phê", icon: "🍜" },
  { value: "service", label: "Dịch vụ", examples: "Salon, sửa chữa, giặt là", icon: "✂️" },
  { value: "mixed", label: "Hỗn hợp", examples: "Vừa bán hàng vừa làm dịch vụ", icon: "🧺" },
];

export const BUSINESS_MODEL_LABELS: Record<BusinessModel, string> =
  Object.fromEntries(BUSINESS_MODELS.map((m) => [m.value, m.label])) as Record<
    BusinessModel,
    string
  >;

export type RegistrationStatus = "unknown" | "not_registered" | "registered";

export const REGISTRATION_STATUS_OPTIONS: {
  value: RegistrationStatus;
  label: string;
  hint: string;
}[] = [
  {
    value: "registered",
    label: "Đã đăng ký hộ kinh doanh",
    hint: "Cửa hàng đã có giấy phép kinh doanh",
  },
  {
    value: "not_registered",
    label: "Chưa đăng ký",
    hint: "Đang buôn bán nhưng chưa làm giấy phép",
  },
  {
    value: "unknown",
    label: "Tôi chưa rõ",
    hint: "SoHo sẽ hướng dẫn bạn sau, không sao cả",
  },
];

export type FilingFrequency = "unknown" | "monthly" | "quarterly" | "annual";

export const FILING_FREQUENCY_OPTIONS: {
  value: FilingFrequency;
  label: string;
  hint: string;
}[] = [
  { value: "monthly", label: "Hàng tháng", hint: "Khai báo mỗi tháng một lần" },
  { value: "quarterly", label: "Hàng quý", hint: "Khai báo 3 tháng một lần" },
  { value: "annual", label: "Hàng năm", hint: "Khai báo mỗi năm một lần" },
  { value: "unknown", label: "Tôi chưa rõ", hint: "SoHo sẽ hướng dẫn bạn sau" },
];

export const REGISTRATION_STATUS_LABELS: Record<RegistrationStatus, string> =
  Object.fromEntries(
    REGISTRATION_STATUS_OPTIONS.map((o) => [o.value, o.label]),
  ) as Record<RegistrationStatus, string>;

export const FILING_FREQUENCY_LABELS: Record<FilingFrequency, string> =
  Object.fromEntries(
    FILING_FREQUENCY_OPTIONS.map((o) => [o.value, o.label]),
  ) as Record<FilingFrequency, string>;
