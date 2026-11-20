// Orval mutator: applies BEEMINDER_API_BASE and the auth_token placement from the design doc.
// The generated client calls http(url, init) and expects the parsed response back.
import { ApiResponseError, MissingTokenError, NetworkError } from "./errors.ts";

const DEFAULT_API_BASE = "https://www.beeminder.com/api/v1";

export const http = async <T>(path: string, init: RequestInit): Promise<T> => {
  const token = process.env.BEEMINDER_AUTH_TOKEN;
  if (!token) throw new MissingTokenError("BEEMINDER_AUTH_TOKEN is not set");

  const base = (process.env.BEEMINDER_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const host = new URL(base).host;
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
