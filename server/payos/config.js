import { PayOSConfigError } from "./errors.js";

const PAYOS_CREDENTIAL_KEYS = [
  "PAYOS_CLIENT_ID",
  "PAYOS_API_KEY",
  "PAYOS_CHECKSUM_KEY",
];

function requireEnvironmentVariables(keys) {
  const missing = keys.filter((key) => !process.env[key]?.trim());

  if (missing.length > 0) {
    throw new PayOSConfigError(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }
}

function requireHttpUrl(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new PayOSConfigError(`Missing required environment variable: ${name}`);
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PayOSConfigError(`${name} must be an absolute URL`);
  }

  const isLocalhost = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
    throw new PayOSConfigError(`${name} must use HTTPS outside localhost`);
  }

  return url.toString();
}

export function getPayOSCredentials() {
  requireEnvironmentVariables(PAYOS_CREDENTIAL_KEYS);

  return {
    clientId: process.env.PAYOS_CLIENT_ID.trim(),
    apiKey: process.env.PAYOS_API_KEY.trim(),
    checksumKey: process.env.PAYOS_CHECKSUM_KEY.trim(),
    partnerCode: process.env.PAYOS_PARTNER_CODE?.trim() || undefined,
  };
}

export function getPaymentRedirectUrls() {
  return {
    returnUrl: requireHttpUrl("PAYOS_RETURN_URL"),
    cancelUrl: requireHttpUrl("PAYOS_CANCEL_URL"),
  };
}

export function getWebhookUrl() {
  return requireHttpUrl("PAYOS_WEBHOOK_URL");
}

export function getWebhookForwardConfig() {
  const rawUrl = process.env.PAYOS_WEBHOOK_FORWARD_URL?.trim();
  if (!rawUrl) return null;

  return {
    url: requireHttpUrl("PAYOS_WEBHOOK_FORWARD_URL"),
    token: process.env.PAYOS_WEBHOOK_FORWARD_TOKEN?.trim() || null,
  };
}

