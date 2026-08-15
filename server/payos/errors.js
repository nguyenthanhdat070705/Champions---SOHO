export class PayOSConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "PayOSConfigError";
    this.statusCode = 500;
  }
}

export class RequestError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "RequestError";
    this.statusCode = statusCode;
  }
}

