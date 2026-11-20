import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  type Fake,
  type FakeReply,
  freePort,
  parseJson,
  type RecordedRequest,
  runCli,
  startFake,
  TOKEN,
} from "./helpers.ts";

const fakes: Fake[] = [];

const fake = (reply?: (req: RecordedRequest) => FakeReply): Fake => {
  const started = startFake(reply);
  fakes.push(started);
  return started;
};

afterEach(() => {
  for (const f of fakes.splice(0)) f.stop();
});

afterAll(() => {
  for (const f of fakes.splice(0)) f.stop();
});

const closedBase = () => `http://127.0.0.1:${freePort()}/api/v1`;

const unauthorized: FakeReply = {
  status: 401,
  body: { errors: { message: "Token missing or incorrect token.", token: "..." } },
};

const everyCommand: [string, string[]][] = [
  ["user", ["user"]],
  ["goals", ["goals"]],
  ["goal", ["goal", "readbook"]],
  ["datapoints", ["datapoints", "readbook"]],
  ["add", ["add", "readbook", "1"]],
  ["delete", ["delete", "readbook", "abc123"]],
];

describe("usage errors", () => {
  test.each([
    "abc",
    "NaN",
    "Infinity",
    "-Infinity",
    "1e999",
    "1,5",
    "0x10",
    "1e3",
    "0b101",
    "1_000",
    " 5 ",
    "5 ",
    "+",
  ])("add rejects the non-numeric value %p with exit 3 before any request", async (value) => {
    const f = fake();
    const res = await runCli(["add", "readbook", value], { base: f.base });
    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr.trim()).not.toBe("");
    expect(f.requests).toHaveLength(0);
  });

  test("add accepts a negative value after --", async () => {
    const f = fake();
    const res = await runCli(["add", "readbook", "--", "-1.5"], { base: f.base });
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(f.requests[0]?.body ?? "").value).toBe(-1.5);
  });

  test.each(["", "  "])(
    "add rejects the blank value %p with exit 3 before any request",
    async (value) => {
      const f = fake();
      const res = await runCli(["add", "readbook", value], { base: f.base });
      expect(res.exitCode).toBe(3);
      expect(res.stdout).toBe("");
      expect(f.requests).toHaveLength(0);
    },
  );

  test("--help exits 0 and prints usage to stdout", async () => {
    const f = fake();
    const res = await runCli(["--help"], { base: f.base });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Usage: beeminder");
    expect(res.stderr).toBe("");
    expect(f.requests).toHaveLength(0);
  });

  test("add without a value exits 3 before any request", async () => {
    const f = fake();
    const res = await runCli(["add", "readbook"], { base: f.base });
    expect(res.exitCode).toBe(3);
    expect(f.requests).toHaveLength(0);
  });

  test("an unknown command exits 3 before any request", async () => {
    const f = fake();
    const res = await runCli(["frobnicate"], { base: f.base });
    expect(res.exitCode).toBe(3);
    expect(f.requests).toHaveLength(0);
  });
});

describe("missing token", () => {
  test.each(everyCommand)(
    "%s exits 2 and names the variable without a request",
    async (_n, args) => {
      const f = fake();
      const res = await runCli(args, { base: f.base, token: null });
      expect(res.exitCode).toBe(2);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain("BEEMINDER_AUTH_TOKEN");
      expect(f.requests).toHaveLength(0);
    },
  );

  test("an unreachable API still reports exit 2, not a network failure", async () => {
    const res = await runCli(["user"], { base: closedBase(), token: null });
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("BEEMINDER_AUTH_TOKEN");
  });

  test("an empty token counts as missing", async () => {
    const f = fake();
    const res = await runCli(["user"], { base: f.base, token: "" });
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("BEEMINDER_AUTH_TOKEN");
    expect(f.requests).toHaveLength(0);
  });
});

describe("API errors", () => {
  test.each(everyCommand)("%s exits 2 on a 401 and prints the API message", async (_n, args) => {
    const f = fake(() => unauthorized);
    const res = await runCli(args, { base: f.base });
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr.startsWith("HTTP 401: ")).toBe(true);
    expect(res.stderr).toContain("Token missing or incorrect token.");
    expect(f.requests).toHaveLength(1);
  });

  test("add exits 1 on a 422 and prints the errors body", async () => {
    const f = fake(() => ({ status: 422, body: { errors: "Duplicate request" } }));
    const res = await runCli(["add", "readbook", "1", "--requestid", "r1"], { base: f.base });
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("HTTP 422: Duplicate request\n");
  });

  test("a 404 exits 1 and prints the errors body", async () => {
    const f = fake(() => ({ status: 404, body: { errors: "goal not found" } }));
    const res = await runCli(["goal", "nope"], { base: f.base });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toBe("HTTP 404: goal not found\n");
  });

  test("a non-string errors value is printed as JSON after the status", async () => {
    const f = fake(() => ({ status: 422, body: { errors: { value: ["is not a number"] } } }));
    const res = await runCli(["add", "readbook", "1"], { base: f.base });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toBe('HTTP 422: {"value":["is not a number"]}\n');
  });

  test("an empty error body prints the status alone", async () => {
    const f = fake(() => ({ status: 503, body: null, text: "" }));
    const res = await runCli(["user"], { base: f.base });
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("HTTP 503\n");
  });

  test("a non-JSON error body is printed verbatim and exits 1", async () => {
    const f = fake(() => ({ status: 500, body: null, text: "boom" }));
    const res = await runCli(["user"], { base: f.base });
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("HTTP 500: boom\n");
  });

  test("a 401 that echoes the token back exits 2 without printing the token", async () => {
    const f = fake((req) => ({
      status: 401,
      body: {
        errors: {
          message: "Token missing or incorrect token.",
          token: req.query.get("auth_token"),
        },
      },
    }));
    const res = await runCli(["user"], { base: f.base });
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("Token missing or incorrect token.");
    expect(res.stderr).toContain("<redacted>");
    expect(res.stderr).not.toContain(TOKEN);
  });

  test("a network failure exits 1 and names the unreachable host", async () => {
    const base = closedBase();
    const res = await runCli(["user"], { base });
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(new URL(base).host);
  });
});

describe("request shape", () => {
  const paths: [string[], string, string][] = [
    [["user"], "GET", "/users/{u}.json"],
    [["goals"], "GET", "/users/{u}/goals.json"],
    [["goal", "readbook"], "GET", "/users/{u}/goals/readbook.json"],
    [["datapoints", "readbook"], "GET", "/users/{u}/goals/readbook/datapoints.json"],
    [["add", "readbook", "1"], "POST", "/users/{u}/goals/readbook/datapoints.json"],
    [
      ["delete", "readbook", "abc123"],
      "DELETE",
      "/users/{u}/goals/readbook/datapoints/abc123.json",
    ],
  ];

  test.each(paths)("%p defaults to user me", async (args, method, template) => {
    const f = fake();
    const res = await runCli(args, { base: f.base });
    expect(res.exitCode).toBe(0);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.method).toBe(method);
    expect(f.requests[0]?.path).toBe(`/api/v1${template.replace("{u}", "me")}`);
  });

  test.each(paths)("%p honours --user", async (args, method, template) => {
    const f = fake();
    const res = await runCli([...args, "--user", "alice"], { base: f.base });
    expect(res.exitCode).toBe(0);
    expect(f.requests[0]?.method).toBe(method);
    expect(f.requests[0]?.path).toBe(`/api/v1${template.replace("{u}", "alice")}`);
  });

  test("GET and DELETE carry auth_token in the query and no body", async () => {
    const f = fake();
    for (const args of [
      ["user"],
      ["goals"],
      ["datapoints", "readbook"],
      ["delete", "readbook", "x"],
    ]) {
      expect((await runCli(args, { base: f.base })).exitCode).toBe(0);
    }
    expect(f.requests).toHaveLength(4);
    for (const req of f.requests) {
      expect(req.query.get("auth_token")).toBe(TOKEN);
      expect(req.body).toBe("");
    }
  });

  test("POST carries auth_token in the JSON body, not in the URL", async () => {
    const f = fake();
    const res = await runCli(["add", "readbook", "3"], { base: f.base });
    expect(res.exitCode).toBe(0);
    const req = f.requests[0];
    expect(req?.query.has("auth_token")).toBe(false);
    expect(req?.headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(req?.body ?? "").auth_token).toBe(TOKEN);
  });

  test.each(["/", "//"])(
    "an API base with trailing slashes %p still hits /users/me.json exactly",
    async (slashes) => {
      const f = fake();
      const res = await runCli(["user"], { base: `${f.base}${slashes}` });
      expect(res.exitCode).toBe(0);
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0]?.path).toBe("/api/v1/users/me.json");
    },
  );

  test("no request uses an Authorization header", async () => {
    const f = fake();
    await runCli(["user"], { base: f.base });
    await runCli(["add", "readbook", "3"], { base: f.base });
    expect(f.requests).toHaveLength(2);
    for (const req of f.requests) expect(req.headers.get("authorization")).toBeNull();
  });

  test("stdout is exactly the response body as JSON", async () => {
    const f = fake(() => ({ status: 200, body: { id: "42", value: 7 } }));
    const res = await runCli(["delete", "readbook", "42"], { base: f.base });
    expect(res.exitCode).toBe(0);
    expect(parseJson(res.stdout)).toEqual({ id: "42", value: 7 });
  });
});
