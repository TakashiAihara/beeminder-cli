export class MissingTokenError extends Error {}

export class UsageError extends Error {}

export class NetworkError extends Error {}

export class ApiResponseError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

export const redactToken = (text: string): string => {
  const token = process.env.BEEMINDER_AUTH_TOKEN;
  if (!token) return text;
  return text.split(token).join("<redacted>").split(encodeURIComponent(token)).join("<redacted>");
};

export function fail(message: string, code: number): never {
  process.stderr.write(`${redactToken(message)}\n`);
  process.exit(code);
}

const errorText = (status: number, body: unknown): string => {
  const errors =
    body !== null && typeof body === "object" && "errors" in body
      ? (body as { errors: unknown }).errors
      : body;
  if (errors === null) return `HTTP ${status}`;
  return `HTTP ${status}: ${typeof errors === "string" ? errors : JSON.stringify(errors)}`;
};

export function reportError(err: unknown): never {
  if (err instanceof MissingTokenError) fail(err.message, 2);
  if (err instanceof UsageError) fail(err.message, 3);
  if (err instanceof ApiResponseError) {
    fail(errorText(err.status, err.body), err.status === 401 ? 2 : 1);
  }
  fail(err instanceof Error ? err.message : String(err), 1);
}
