import { RequestError } from "./errors.js";

const BUYER_STRING_FIELDS = [
  "buyerName",
  "buyerCompanyName",
  "buyerTaxCode",
  "buyerEmail",
  "buyerPhone",
  "buyerAddress",
];

function positiveSafeInteger(value, fieldName) {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RequestError(400, `${fieldName} must be a positive integer`);
  }

  return parsed;
}

function optionalString(value, fieldName, maxLength = 255) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new RequestError(400, `${fieldName} must be a string`);
  }

  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new RequestError(
      400,
      `${fieldName} must contain 1-${maxLength} characters`,
    );
  }

  return normalized;
}

function parseItems(items) {
  if (items === undefined) return undefined;
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
    throw new RequestError(400, "items must be an array containing 1-100 items");
  }

  return items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new RequestError(400, `items[${index}] must be an object`);
    }

    const parsedItem = {
      name: optionalString(item.name, `items[${index}].name`, 255),
      quantity: positiveSafeInteger(item.quantity, `items[${index}].quantity`),
      price: positiveSafeInteger(item.price, `items[${index}].price`),
    };

    if (!parsedItem.name) {
      throw new RequestError(400, `items[${index}].name is required`);
    }

    const unit = optionalString(item.unit, `items[${index}].unit`, 50);
    if (unit) parsedItem.unit = unit;

    if (item.taxPercentage !== undefined) {
      const allowedTaxRates = [-2, -1, 0, 5, 10];
      if (!allowedTaxRates.includes(item.taxPercentage)) {
        throw new RequestError(
          400,
          `items[${index}].taxPercentage must be -2, -1, 0, 5, or 10`,
        );
      }
      parsedItem.taxPercentage = item.taxPercentage;
    }

    return parsedItem;
  });
}

export function parseCreatePaymentRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError(400, "Request body must be a JSON object");
  }

  const orderCode = positiveSafeInteger(body.orderCode, "orderCode");
  const amount = positiveSafeInteger(body.amount, "amount");
  const defaultDescription = `DH${String(orderCode).slice(-7)}`;
  const description =
    optionalString(body.description, "description", 9) || defaultDescription;

  const payment = { orderCode, amount, description };

  const items = parseItems(body.items);
  if (items) payment.items = items;

  for (const field of BUYER_STRING_FIELDS) {
    const value = optionalString(body[field], field);
    if (value) payment[field] = value;
  }

  if (body.expiredAt !== undefined) {
    payment.expiredAt = positiveSafeInteger(body.expiredAt, "expiredAt");
  }

  return payment;
}

export function parsePaymentIdentifier(value) {
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== "string" || !value.trim()) {
    throw new RequestError(400, "Query parameter id is required");
  }

  const id = value.trim();
  if (id.length > 128) {
    throw new RequestError(400, "Payment identifier is too long");
  }

  if (/^\d+$/.test(id)) {
    const orderCode = Number(id);
    if (Number.isSafeInteger(orderCode)) return orderCode;
  }

  return id;
}

export function parseCancellationReason(body) {
  if (!body || typeof body !== "object") return undefined;
  return optionalString(body.cancellationReason, "cancellationReason", 255);
}

