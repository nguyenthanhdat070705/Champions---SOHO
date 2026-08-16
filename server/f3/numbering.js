// Human-readable per-merchant document numbers. Kept short and high-entropy so
// the (merchant_id, number) unique constraints effectively never collide in the
// pilot; on the astronomically-rare clash the enclosing insert fails and the
// caller retries with a fresh request. Numbers are display ids, never guessable
// global sequences (spec 13.2 security).

function token(n = 5) {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no I/L/O to avoid confusion
  let s = "";
  for (let i = 0; i < n; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return s;
}

function ymd(businessDate) {
  // businessDate is 'YYYY-MM-DD'; compact to YYMMDD for the display code.
  const compact = String(businessDate || "").replace(/-/g, "");
  return compact.slice(2); // drop century
}

export function orderNumber(businessDate) {
  return `B${ymd(businessDate)}-${token(5)}`;
}

export function returnNumber(businessDate) {
  return `TR${ymd(businessDate)}-${token(5)}`;
}

export function expenseNumber(businessDate) {
  return `CP-${ymd(businessDate)}-${token(5)}`;
}

export function receiptNumber(prefix, businessDate) {
  const p = (prefix || "SOHO").replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "SOHO";
  return `${p}-${ymd(businessDate)}-${token(5)}`;
}
