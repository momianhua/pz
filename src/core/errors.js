export class GatewayError extends Error {
  constructor(code, message, status = 500, details) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function normalizeError(error) {
  if (error instanceof GatewayError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new GatewayError("ENGINE_ERROR", message, 502);
}
