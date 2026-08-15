// Thin Functional 03 wrapper over the existing PayOS client (server/payos). QR
// bills are provider-driven: the backend creates the payment request, the mobile
// only renders what the provider returns, and ONLY a signature-verified webhook
// (or a server-to-server reconcile) marks a bill paid — never the returnUrl
// (spec 5.2). Env var names are unchanged so the same Railway service redeploys.
import { getPayOSClient } from "../payos/client.js";
import { getPaymentRedirectUrls } from "../payos/config.js";
import { DomainError } from "./errors.js";

let orderCodeCounter = 0;

/**
 * A unique positive integer orderCode for PayOS. Derived from the clock plus a
 * per-process counter so concurrent creates don't collide. We never persist it:
 * the webhook and status GET both key on paymentLinkId, which we DO store.
 */
export function generateOrderCode() {
  orderCodeCounter = (orderCodeCounter + 1) % 100;
  const base = Date.now() % 100_000_000; // 8 digits
  return base * 100 + orderCodeCounter; // ≤ ~1e10, safe integer
}

/**
 * Create a VietQR dynamic payment request for `amount` đồng. Returns the
 * provider fields the mobile needs (qrCode string, checkoutUrl, paymentLinkId,
 * expiredAt). Maps provider/SDK failures to a clean PROVIDER_ERROR.
 */
export async function createQrRequest({ orderCode, amount, description, expiredAtUnix }) {
  let redirect;
  try {
    redirect = getPaymentRedirectUrls();
  } catch {
    // Redirect URLs are cosmetic for QR; fall back to safe localhost defaults.
    redirect = {
      returnUrl: "http://localhost:3000/payment/success.html",
      cancelUrl: "http://localhost:3000/payment/cancel.html",
    };
  }
  const payload = {
    orderCode,
    amount,
    description: description || `DH${String(orderCode).slice(-7)}`,
    ...redirect,
  };
  if (expiredAtUnix) payload.expiredAt = expiredAtUnix;

  try {
    const result = await getPayOSClient().paymentRequests.create(payload);
    return {
      paymentLinkId: String(result.paymentLinkId),
      qrCode: result.qrCode || null,
      checkoutUrl: result.checkoutUrl || null,
      accountName: result.accountName || null,
      accountNumber: result.accountNumber || null,
      bin: result.bin || null,
      amount: result.amount,
      status: result.status || "PENDING",
      expiredAt: result.expiredAt || expiredAtUnix || null,
    };
  } catch (err) {
    throw new DomainError("PROVIDER_ERROR", undefined, {
      provider: "payos",
      reason: err?.desc || err?.message || "create failed",
    });
  }
}

/** Server-to-server reconcile of a PayOS request (by paymentLinkId or orderCode). */
export async function getQrRequest(id) {
  try {
    return await getPayOSClient().paymentRequests.get(id);
  } catch (err) {
    throw new DomainError("PROVIDER_ERROR", undefined, {
      provider: "payos",
      reason: err?.desc || err?.message || "get failed",
    });
  }
}

/** Ask PayOS to cancel a still-pending request. Best-effort; never throws. */
export async function cancelQrRequest(id, reason) {
  try {
    return await getPayOSClient().paymentRequests.cancel(id, reason);
  } catch (err) {
    // The local row is the source of truth for our state machine; log and move on.
    console.warn("payos cancel failed", err?.desc || err?.message);
    return null;
  }
}

/** Verify a raw webhook body's signature; returns the verified data or throws. */
export async function verifyWebhook(body) {
  return getPayOSClient().webhooks.verify(body);
}
