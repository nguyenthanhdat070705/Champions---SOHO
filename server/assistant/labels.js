// Server-side Vietnamese labels for DB enums used in the FACTS pack. Mirrors the
// authoritative client list in src/lib/enums.ts (keep values in sync with the
// deployed schema — e.g. `food_beverage`, not `fnb`).
export const BUSINESS_MODEL_LABELS = Object.freeze({
  retail: "Bán lẻ",
  food_beverage: "Ăn uống (F&B)",
  service: "Dịch vụ",
  mixed: "Hỗn hợp",
});
