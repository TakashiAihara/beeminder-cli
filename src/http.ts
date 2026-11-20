// Orval mutator: applies BEEMINDER_API_BASE and the auth_token placement from the design doc.
// The generated client calls http(url, init) and expects the parsed response back.
import { ApiResponseError, MissingTokenError, NetworkError, UsageError } from "./errors.ts";

const DEFAULT_API_BASE = "https://www.beeminder.com/api/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

// http is cleartext, so it is only accepted on loopback hosts; everywhere else must be https.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const apiBase = (): { base: string; host: string } => {
  const raw = process.env.BEEMINDER_API_BASE ?? DEFAULT_API_BASE;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`BEEMINDER_API_BASE is not a valid URL: ${JSON.stringify(raw)}`);
  }
  const loopbackHttp = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw new UsageError(
      `BEEMINDER_API_BASE must be https (http only for localhost/127.0.0.1/[::1]): ${JSON.stringify(raw)}`,
    );
  }
  return { base: raw.replace(/\/+$/, ""), host: url.host };
};

const requestTimeoutMs = (): number => {
  const raw = process.env.BEEMINDER_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 0) {
    throw new UsageError(
      `BEEMINDER_TIMEOUT_MS is not a number of milliseconds: ${JSON.stringify(raw)}`,
    );
  }
  return ms;
};

export const http = async <T>(path: string, init: RequestInit): Promise<T> => {
  const token = process.env.BEEMINDER_AUTH_TOKEN;
  if (!token) throw new MissingTokenError("BEEMINDER_AUTH_TOKEN is not set");

  const { base, host } = apiBase();
  const method = (init.method ?? "GET").toUpperCase();

  // Bearer is rejected by the API: POST/PUT carry auth_token in the JSON body,
  // GET/DELETE in the query. A bodyless POST still falls back to the query.
  const request: RequestInit = { ...init };
  let url = `${base}${path}`;
  if (
    (method === "POST" || method === "PUT") &&
    typeof request.body === "string" &&
    request.body.length > 0
  ) {
    const body = JSON.parse(request.body) as Record<string, unknown>;
    body.auth_token = token;
    request.body = JSON.stringify(body);
  } else {
    url = `${url}${url.includes("?") ? "&" : "?"}auth_token=${encodeURIComponent(token)}`;
  }

  request.signal = AbortSignal.timeout(requestTimeoutMs());

  let response: Response;
  try {
    response = await fetch(url, request);
  } catch (err) {
    throw new NetworkError(
      `cannot reach ${host}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // error bodies may not be JSON; report them verbatim
    data = text;
  }

  if (!response.ok) throw new ApiResponseError(response.status, data);
  return { data, status: response.status, headers: response.headers } as T;
};
