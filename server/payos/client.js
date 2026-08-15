import { PayOS } from "@payos/node";
import { getPayOSCredentials } from "./config.js";

let payOSClient;

export function getPayOSClient() {
  if (!payOSClient) {
    payOSClient = new PayOS({
      ...getPayOSCredentials(),
      maxRetries: 2,
      timeout: 15_000,
      logLevel: process.env.PAYOS_LOG?.trim() || "warn",
    });
  }

  return payOSClient;
}

