import assert from "node:assert/strict";
import test from "node:test";
import {
  numberTokens,
  allowedNumberSet,
  numbersGrounded,
  ungroundedTokens,
} from "../server/assistant/numbers.js";

test("numberTokens canonicalises VN-grouped money, %, and embedded digits", () => {
  assert.deepEqual(numberTokens("Hôm nay 1.234.000đ, 3 bill, còn 5"), ["1234000", "3", "5"]);
  assert.deepEqual(numberTokens("tăng 300% so với tuần trước"), ["300"]);
  assert.deepEqual(numberTokens("Nước suối 500ml"), ["500"]);
  assert.deepEqual(numberTokens("không có số"), []);
  assert.deepEqual(numberTokens(""), []);
  assert.deepEqual(numberTokens(null), []);
});

test("allowedNumberSet contains every canonical token from the facts text", () => {
  const set = allowedNumberSet("Doanh thu 700.000đ, 3 bill, còn 5");
  assert.ok(set.has("700000"));
  assert.ok(set.has("3"));
  assert.ok(set.has("5"));
  assert.ok(!set.has("999999"));
});

test("numbersGrounded: true when every reply number is in the facts", () => {
  const facts = "net 700.000đ; 3 bill; tiền mặt 400.000đ; QR 300.000đ";
  assert.equal(numbersGrounded("Bán được 700.000đ từ 3 bill", facts), true);
  assert.equal(numbersGrounded("Tiền mặt 400.000đ, QR 300.000đ", facts), true);
  assert.equal(numbersGrounded("Không có con số nào ở đây", facts), true);
});

test("numbersGrounded: false when the reply invents a number (hallucination)", () => {
  const facts = "net 700.000đ; 3 bill";
  assert.equal(numbersGrounded("Bán được 999.999đ", facts), false);
  assert.equal(numbersGrounded("Có 8 bill hôm nay", facts), false);
  assert.deepEqual(ungroundedTokens("Bán 999.999đ và 8 bill", facts).sort(), ["8", "999999"]);
});

test("a product name with digits is grounded when the name is in the facts", () => {
  const facts = "Nước suối 500ml: còn 5";
  assert.equal(numbersGrounded("Nước suối 500ml sắp hết, còn 5", facts), true);
});
