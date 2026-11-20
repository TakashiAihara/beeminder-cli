import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  type Fake,
  type FakeReply,
  freePort,
  type RecordedRequest,
  runCli,
  startFake,
  startHang,
} from "./helpers.ts";

const fakes: { stop: () => void }[] = [];

const fake = (reply?: (req: RecordedRequest) => FakeReply): Fake => {
  const started = startFake(reply);
  fakes.push(started);
  return started;
};

const stopAll = () => {
  for (const f of fakes.splice(0)) f.stop();
};

afterEach(stopAll);
afterAll(stopAll);

const REPO_ROOT = new URL("../../", import.meta.url).pathname;

describe("path parameters are validated before any request", () => {
  const rejected: [string, string[]][] = [
    [
      "slug with a path and a query (money-charging endpoint)",
      ["add", "readbook/uncleme.json?", "1"],
    ],
    ["slug with a slash", ["goal", "a/b"]],
    ["slug with a question mark", ["goal", "a?x=1"]],
    ["slug with a hash", ["goal", "a#b"]],
    ["slug with a space", ["goal", "a b"]],
    ["slug of dots", ["goal", ".."]],
    ["empty slug", ["goal", ""]],
    ["slug in datapoints", ["datapoints", "g/h"]],
    ["id that climbs out of the goal", ["delete", "readbook", "../../x"]],
    ["id with a dash", ["delete", "readbook", "a-b"]],
    ["id with a dot", ["delete", "readbook", "abc.json"]],
    ["id with a query", ["delete", "readbook", "abc?x=1"]],
    ["slug in delete", ["delete", "a/b", "abc123"]],
    ["user with a slash", ["user", "--user", "al/ice"]],
    ["user with a query", ["goals", "--user", "a?b"]],
    ["user of dots", ["user", "--user", ".."]],
    ["empty user", ["user", "--user", ""]],
  ];

  test.each(rejected)("%s exits 3 and sends nothing", async (_name, args) => {
    const f = fake();
    const res = await runCli(args, { base: f.base });
    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr.trim()).not.toBe("");
    expect(f.requests).toHaveLength(0);
  });

  test("underscores, dashes and digits are accepted in user and slug, alphanumerics in id", async () => {
    const f = fake();
    const res = await runCli(["delete", "my_goal-1", "abc123XYZ", "--user", "a_b-c"], {
      base: f.base,
    });
    expect(res.exitCode).toBe(0);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.path).toBe(
      "/api/v1/users/a_b-c/goals/my_goal-1/datapoints/abc123XYZ.json",
    );
  });
});

describe("add value format", () => {
  test.each([
    ["2", 2],
    ["0.25", 0.25],
    ["+3", 3],
    ["007", 7],
  ])("%p is a plain decimal and is sent as %p", async (raw, expected) => {
    const f = fake();
    const res = await runCli(["add", "readbook", raw], { base: f.base });
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(f.requests[0]?.body ?? "").value).toBe(expected);
  });
});

describe("--daystamp", () => {
  test.each(["2026-01-15", "2026011", "202601155", "abcdefgh", "", "2026 115"])(
    "add rejects %p with exit 3 before any request",
    async (daystamp) => {
      const f = fake();
      const res = await runCli(["add", "readbook", "1", "--daystamp", daystamp], { base: f.base });
      expect(res.exitCode).toBe(3);
      expect(res.stdout).toBe("");
      expect(f.requests).toHaveLength(0);
    },
  );

  test("eight digits are sent as given", async () => {
    const f = fake();
    const res = await runCli(["add", "readbook", "1", "--daystamp", "20260115"], { base: f.base });
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(f.requests[0]?.body ?? "").daystamp).toBe("20260115");
  });
});

describe("--version", () => {
  test("prints the package.json version to stdout and exits 0 without a request", async () => {
    const pkg = JSON.parse(await Bun.file(`${REPO_ROOT}package.json`).text()) as {
      version: string;
    };
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    const f = fake();
    const res = await runCli(["--version"], { base: f.base, token: null });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(pkg.version);
    expect(res.stderr).toBe("");
    expect(f.requests).toHaveLength(0);
  });
});

describe("BEEMINDER_API_BASE scheme", () => {
  test.each([
    "http://example.com/api/v1",
    "http://127.0.0.1.example.com/api/v1",
    "http://localhost.example.com/api/v1",
    "http://user@127.0.0.1.example.com/api/v1",
    "ftp://example.com/api/v1",
    "not a url",
  ])("%p exits 3 before any request", async (base) => {
    const res = await runCli(["user"], { base });
    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr.trim()).not.toBe("");
  });

  test.each(["http://localhost", "http://127.0.0.1", "http://[::1]", "https://127.0.0.1"])(
    "%s:<closed port> is accepted and fails as a network error (exit 1)",
    async (host) => {
      const base = `${host}:${freePort()}/api/v1`;
      const res = await runCli(["user"], { base });
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain(new URL(base).host);
    },
  );
});

describe("request timeout", () => {
  test("a server that never answers ends with exit 1 naming host:port", async () => {
    const hang = startHang();
    fakes.push(hang);
    const started = Date.now();
    const res = await runCli(["user"], { base: hang.base, env: { BEEMINDER_TIMEOUT_MS: "500" } });
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(new URL(hang.base).host);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});

describe("token redaction", () => {
  // Characters that encodeURIComponent rewrites, so the raw and the encoded form differ.
  const odd = "tok+en/abc=";

  const echo = (status: number) => (req: RecordedRequest) => {
    const received = req.query.get("auth_token") ?? JSON.parse(req.body).auth_token;
    return {
      status,
      body: {
        errors: `bad ${received} / ${encodeURIComponent(received)} / ${req.query.toString()}`,
      },
    };
  };

  test.each([
    ["GET user, 401", ["user"], 401, 2],
    ["GET user, 422", ["user"], 422, 1],
    ["DELETE, 422", ["delete", "readbook", "abc123"], 422, 1],
    ["POST add, 422", ["add", "readbook", "1"], 422, 1],
  ] as const)(
    "%s: neither the raw nor the URL-encoded token reaches stderr",
    async (_n, args, status, code) => {
      const f = fake(echo(status));
      const res = await runCli([...args], { base: f.base, token: odd });
      expect(f.requests).toHaveLength(1);
      expect(res.stderr).not.toContain(odd);
      expect(res.stderr).not.toContain(encodeURIComponent(odd));
      expect(res.stdout).not.toContain(odd);
      expect(res.stdout).not.toContain(encodeURIComponent(odd));
      expect(res.exitCode).toBe(code);
      expect(res.stderr.startsWith(`HTTP ${status}: bad `)).toBe(true);
    },
  );
});
