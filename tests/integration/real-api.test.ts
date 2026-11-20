import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const token = process.env.BEEMINDER_TEST_AUTH_TOKEN;
const goal = process.env.BEEMINDER_TEST_GOAL;
const required = process.env.BEEMINDER_REQUIRE_INTEGRATION === "1";
const configured = Boolean(token && goal);

const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const PREFIX = "beeminder-cli-test-";
const API = process.env.BEEMINDER_API_BASE ?? "https://www.beeminder.com/api/v1";

const TOKEN = token ?? "";
const GOAL = goal ?? "";

// Each real-API call can take a few seconds; Bun's 5 s default would cut a test short.
const HOOK_TIMEOUT_MS = 60_000;

// The direct cleanup below sends the token in the query, so it applies the same
// https-or-loopback rule as the CLI does.
const assertSafeApiBase = (): void => {
  const url = new URL(API);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`refusing to send the token to a non-https API base: ${url.origin}`);
  }
};

// Set only after the goal passed the safety check, so afterAll never deletes from a
// goal that beforeAll rejected.
let safeToClean = false;

type Datapoint = { id: string; value: number; comment?: string; requestid?: string };

if (!configured && required) {
  test("BEEMINDER_TEST_AUTH_TOKEN and BEEMINDER_TEST_GOAL are set", () => {
    throw new Error(
      "BEEMINDER_REQUIRE_INTEGRATION=1 but BEEMINDER_TEST_AUTH_TOKEN or BEEMINDER_TEST_GOAL is missing",
    );
  });
} else if (!configured) {
  console.warn(
    "BEEMINDER_TEST_AUTH_TOKEN or BEEMINDER_TEST_GOAL is not set: skipping the real-API integration tests",
  );
}

const expectNoToken = (text: string, secret: string): void => {
  expect(text).not.toContain(secret);
  expect(text).not.toContain(encodeURIComponent(secret));
};

// The CLI gets the same API base as the cleanup below, so both talk to the same server.
const cli = async (
  args: string[],
  authToken: string = TOKEN,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    BEEMINDER_AUTH_TOKEN: authToken,
    BEEMINDER_API_BASE: API,
  };
  const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expectNoToken(stdout, authToken);
  expectNoToken(stderr, authToken);
  return { exitCode, stdout, stderr };
};

// Cleanup must not depend on the CLI under test, so it talks to the API directly.
// path is relative to /users/me/goals/.
const directFetch = async (method: "GET" | "DELETE", path: string): Promise<unknown> => {
  const url = `${API}/users/me/goals/${path}?auth_token=${encodeURIComponent(TOKEN)}`;
  const res = await fetch(url, { method });
  if (!res.ok) throw new Error(`${method} ${path} failed with HTTP ${res.status}`);
  return res.json();
};

const removeLeftovers = async (): Promise<void> => {
  const points = (await directFetch("GET", `${GOAL}/datapoints.json`)) as Datapoint[];
  for (const point of points) {
    if (point.comment?.startsWith(PREFIX)) {
      await directFetch("DELETE", `${GOAL}/datapoints/${point.id}.json`);
    }
  }
};

describe.skipIf(!configured)("real Beeminder API (goal from BEEMINDER_TEST_GOAL)", () => {
  beforeAll(async () => {
    assertSafeApiBase();
    const found = (await directFetch("GET", `${GOAL}.json`)) as { aggday?: string };
    if (found.aggday !== "sum") {
      throw new Error(
        `goal ${GOAL} has aggday ${JSON.stringify(found.aggday)}, expected "sum": the value-0 test datapoints could otherwise change the goal's progress`,
      );
    }
    safeToClean = true;
    await removeLeftovers();
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    if (safeToClean) await removeLeftovers();
  }, HOOK_TIMEOUT_MS);

  test(
    "add, read back and delete a datapoint",
    async () => {
      const requestid = `${PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const comment = `${PREFIX}${requestid}`;

      const added = await cli(["add", GOAL, "0", "--comment", comment, "--requestid", requestid]);
      expect(added.exitCode).toBe(0);
      const created = JSON.parse(added.stdout) as Datapoint;
      expect(typeof created.id).toBe("string");
      expect(created.requestid).toBe(requestid);

      const listed = await cli(["datapoints", GOAL]);
      expect(listed.exitCode).toBe(0);
      const found = (JSON.parse(listed.stdout) as Datapoint[]).find((p) => p.id === created.id);
      expect(found?.comment).toBe(comment);
      expect(found?.value).toBe(0);

      const deleted = await cli(["delete", GOAL, created.id]);
      expect(deleted.exitCode).toBe(0);
      expect((JSON.parse(deleted.stdout) as Datapoint).id).toBe(created.id);

      const after = await cli(["datapoints", GOAL]);
      expect((JSON.parse(after.stdout) as Datapoint[]).some((p) => p.id === created.id)).toBe(
        false,
      );
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "read commands never print the token",
    async () => {
      for (const args of [["user"], ["goals"], ["goal", GOAL]]) {
        const res = await cli(args);
        expect(res.exitCode).toBe(0);
      }
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "an invalid token exits 2 and is not echoed",
    async () => {
      const res = await cli(["user"], "not+a/real=token");
      expect(res.exitCode).toBe(2);
    },
    HOOK_TIMEOUT_MS,
  );
});
