import { afterAll, describe, expect, test } from "bun:test";

const token = process.env.BEEMINDER_TEST_AUTH_TOKEN;
const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const GOAL = "readbook";
const PREFIX = "beeminder-cli-test-";
const API = process.env.BEEMINDER_API_BASE ?? "https://www.beeminder.com/api/v1";

if (!token) {
  console.warn("BEEMINDER_TEST_AUTH_TOKEN is not set: skipping the real-API integration tests");
}

type Datapoint = { id: string; value: number; comment?: string; requestid?: string };

const cli = async (
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      BEEMINDER_AUTH_TOKEN: token ?? "",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

// Cleanup must not depend on the CLI under test, so it talks to the API directly.
const directFetch = async (method: "GET" | "DELETE", path: string): Promise<unknown> => {
  const url = `${API}/users/me/goals/${GOAL}/${path}?auth_token=${encodeURIComponent(token ?? "")}`;
  const res = await fetch(url, { method });
  if (!res.ok) throw new Error(`${method} ${path} failed with HTTP ${res.status}`);
  return res.json();
};

const removeLeftovers = async (): Promise<void> => {
  const points = (await directFetch("GET", "datapoints.json")) as Datapoint[];
  for (const point of points) {
    if (point.comment?.startsWith(PREFIX))
      await directFetch("DELETE", `datapoints/${point.id}.json`);
  }
};

describe.skipIf(!token)("real Beeminder API (goal readbook)", () => {
  afterAll(async () => {
    await removeLeftovers();
  });

  test("add, read back and delete a datapoint", async () => {
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
    expect((JSON.parse(after.stdout) as Datapoint[]).some((p) => p.id === created.id)).toBe(false);
  });

  test("an invalid token exits 2", async () => {
    const proc = Bun.spawn([process.execPath, "src/cli.ts", "user"], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        BEEMINDER_AUTH_TOKEN: "not-a-real-token",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, , exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(2);
  });
});
