// Server-side VND formatting for receipt HTML. Mirrors src/lib/format.ts
// (integer đồng, Vietnamese grouping, honest negatives).
export function formatVnd(amount) {
  if (!Number.isFinite(amount)) return "0đ";
  const n = Math.trunc(amount);
  const neg = n < 0;
  const grouped = Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return (neg ? "-" : "") + grouped + "đ";
}
