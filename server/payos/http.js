import { timingSafeEqual } from "node:crypto";
import { APIError, WebhookError } from "@payos/node";
import { PayOSConfigError, RequestError } from "./errors.js";

export function prepareJsonResponse(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
}

export function requireMethod(req, res, allowedMethods) {
  if (allowedMethods.includes(req.method)) return;

  res.setHeader("Allow", allowedMethods.join(", "));
  throw new RequestError(405, "Method not allowed");
}

function safeTokenEquals(expected, actual) {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);

  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

export function requireInternalAccess(req) {
  const expectedToken = process.env.PAYOS_INTERNAL_API_TOKEN?.trim();
  if (!expectedToken) {
    throw new PayOSConfigError(
      "Missing required environment variable: PAYOS_INTERNAL_API_TOKEN",
    );
  }

  const authorization = req.headers.authorization || "";
  const [scheme, token] = authorization.split(" ");

  if (
    scheme?.toLowerCase() !== "bearer" ||
    !token ||
    !safeTokenEquals(expectedToken, token)
  ) {
    throw new RequestError(401, "Unauthorized");
  }
}

export function parseJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      throw new RequestError(400, "Request body must be valid JSON");
    }
  }

  throw new RequestError(400, "Request body must be a JSON object");
}

export function sendJson(res, statusCode, body) {
  prepareJsonResponse(res);
  return res.status(statusCode).json(body);
}

export function sendError(res, error) {
  if (error instanceof RequestError || error instanceof PayOSConfigError) {
    return sendJson(res, error.statusCode, {
      error: error.name,
      message: error.message,
    });
  }

  if (error instanceof WebhookError) {
    return sendJson(res, 400, {
      error: "InvalidWebhook",
      message: "Webhook signature or payload is invalid",
    });
  }

  if (error instanceof APIError) {
    console.error("payOS API request failed", {
      name: error.name,
      status: error.status,
      code: error.code,
      desc: error.desc,
    });

    return sendJson(res, 502, {
      error: "PayOSAPIError",
      message: "payOS rejected or could not complete the request",
    });
  }

  console.error("Unexpected payOS integration error", error);
  return sendJson(res, 500, {
    error: "InternalServerError",
    message: "Unexpected server error",
  });
}
