import { afterEach, describe, expect, test } from "bun:test";

import { http } from "../../src/http.ts";
import { startHang } from "../acceptance/helpers.ts";

type EnvName = "BEEMINDER_AUTH_TOKEN" | "BEEMINDER_API_BASE" | "BEEMINDER_TIMEOUT_MS";

const names: EnvName[] = ["BEEMINDER_AUTH_TOKEN", "BEEMINDER_API_BASE", "BEEMINDER_TIMEOUT_MS"];
const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));

let hang: ReturnType<typeof startHang> | undefined;

afterEach(() => {
  hang?.stop();
  hang = undefined;
  for (const n of names) {
    const value = saved[n];
    if (value === undefined) delete process.env[n];
    else process.env[n] = value;
  }
});

describe("http timeout", () => {
  test("BEEMINDER_TIMEOUT_MS ends a request the server never answers, naming host:port", async () => {
    hang = startHang();
    const base = new URL(hang.base);
    process.env.BEEMINDER_API_BASE = `${base.protocol}//${base.host}`;
    process.env.BEEMINDER_AUTH_TOKEN = "unit-test-token";
    process.env.BEEMINDER_TIMEOUT_MS = "300";
    const started = Date.now();
    // Raced so a missing timeout fails this test instead of hanging the run.
    const outcome = await Promise.race([
      http("/things.json", { method: "GET" }).then(
        () => "resolved",
        (err: Error) => err.message,
      ),
      Bun.sleep(3000).then(() => "no timeout within 3s"),
    ]);
    expect(outcome).toContain(base.host);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
