import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { http } from "../../src/http.ts";

const TOKEN = "unit-test-token";

type Seen = { method: string; path: string; query: URLSearchParams; body: string };

type HttpResult = { data: unknown; status: number };

type EnvName = "BEEMINDER_AUTH_TOKEN" | "BEEMINDER_API_BASE";

let server: ReturnType<typeof Bun.serve> | undefined;
let seen: Seen[] = [];
const saved: Record<EnvName, string | undefined> = {
  BEEMINDER_AUTH_TOKEN: process.env.BEEMINDER_AUTH_TOKEN,
  BEEMINDER_API_BASE: process.env.BEEMINDER_API_BASE,
};

const restore = (name: EnvName) => {
  const value = saved[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

const startFake = (respond: () => Response = () => Response.json({ ok: true })) => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        body: await req.text(),
      });
      return respond();
    },
  });
  process.env.BEEMINDER_API_BASE = `http://127.0.0.1:${server.port}`;
  process.env.BEEMINDER_AUTH_TOKEN = TOKEN;
};

beforeEach(() => {
  seen = [];
});

afterEach(() => {
  server?.stop(true);
  server = undefined;
  restore("BEEMINDER_AUTH_TOKEN");
  restore("BEEMINDER_API_BASE");
});

describe("http auth_token placement", () => {
  test("a PUT with a JSON body carries auth_token in the body, not the query", async () => {
    startFake();
    await http("/things/1.json", { method: "PUT", body: JSON.stringify({ value: 7 }) });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("PUT");
    expect(seen[0]?.query.has("auth_token")).toBe(false);
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ value: 7, auth_token: TOKEN });
  });

  test("a POST without a body carries auth_token in the query and sends no body", async () => {
    startFake();
    await http("/things.json", { method: "POST" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.query.get("auth_token")).toBe(TOKEN);
    expect(seen[0]?.body).toBe("");
  });

  test("a POST with an empty-string body carries auth_token in the query and sends no body", async () => {
    startFake();
    await http("/things.json", { method: "POST", body: "" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.query.get("auth_token")).toBe(TOKEN);
    expect(seen[0]?.body).toBe("");
  });

  test("a path that already has a query string keeps it and gains auth_token", async () => {
    startFake();
    await http("/things.json?x=1", { method: "GET" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe("/things.json");
    expect(seen[0]?.query.get("x")).toBe("1");
    expect(seen[0]?.query.get("auth_token")).toBe(TOKEN);
  });
});

describe("http responses", () => {
  test("a 2xx with an empty body resolves with null data", async () => {
    startFake(() => new Response("", { status: 200 }));
    const res = await http<HttpResult>("/things.json", { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.data).toBeNull();
  });
});
