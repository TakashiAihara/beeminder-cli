import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type Mock, parseJson, runCli, startPrism, TOKEN } from "./helpers.ts";

let mock: Mock;

beforeAll(async () => {
  mock = await startPrism();
}, 40_000);

afterAll(async () => {
  await mock?.stop();
});

beforeEach(() => {
  mock.requests.length = 0;
});

const run = (args: string[]) => runCli(args, { base: mock.base });

const asObject = (value: unknown): Record<string, unknown> => {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
};

describe("commands against the spec mock", () => {
  test("user prints the User object", async () => {
    const res = await run(["user"]);
    expect(res.exitCode).toBe(0);
    expect(typeof asObject(parseJson(res.stdout)).username).toBe("string");
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.path).toBe("/users/me.json");
  });

  test("goals prints an array of Goal objects", async () => {
    const res = await run(["goals"]);
    expect(res.exitCode).toBe(0);
    const goals = parseJson(res.stdout);
    expect(Array.isArray(goals)).toBe(true);
    expect((goals as unknown[]).length).toBeGreaterThan(0);
    for (const goal of goals as unknown[]) {
      expect(typeof asObject(goal).slug).toBe("string");
    }
  });

  test("goal prints one Goal object", async () => {
    const res = await run(["goal", "readbook"]);
    expect(res.exitCode).toBe(0);
    expect(typeof asObject(parseJson(res.stdout)).slug).toBe("string");
    expect(mock.requests[0]?.path).toBe("/users/me/goals/readbook.json");
  });

  test("datapoints prints an array of Datapoint objects", async () => {
    const res = await run(["datapoints", "readbook"]);
    expect(res.exitCode).toBe(0);
    const points = parseJson(res.stdout);
    expect(Array.isArray(points)).toBe(true);
    expect((points as unknown[]).length).toBeGreaterThan(0);
    for (const point of points as unknown[]) {
      expect(typeof asObject(point).id).toBe("string");
    }
    expect(mock.requests[0]?.path).toBe("/users/me/goals/readbook/datapoints.json");
  });

  test("add with only a value sends a numeric value and nothing optional", async () => {
    const res = await run(["add", "readbook", "2.5"]);
    expect(res.exitCode).toBe(0);
    expect(typeof asObject(parseJson(res.stdout)).id).toBe("string");

    const req = mock.requests[0];
    expect(req?.method).toBe("POST");
    expect(req?.path).toBe("/users/me/goals/readbook/datapoints.json");
    expect(JSON.parse(req?.body ?? "")).toEqual({ auth_token: TOKEN, value: 2.5 });
  });

  test("add sends --comment, --requestid and --daystamp in a valid body", async () => {
    const res = await run([
      "add",
      "readbook",
      "1",
      "--comment",
      "read a chapter",
      "--requestid",
      "req-123",
      "--daystamp",
      "20260115",
    ]);
    expect(res.exitCode).toBe(0);
    expect(typeof asObject(parseJson(res.stdout)).id).toBe("string");

    expect(JSON.parse(mock.requests[0]?.body ?? "")).toEqual({
      auth_token: TOKEN,
      value: 1,
      comment: "read a chapter",
      requestid: "req-123",
      daystamp: "20260115",
    });
  });

  test("delete prints the deleted Datapoint", async () => {
    const res = await run(["delete", "readbook", "abc123"]);
    expect(res.exitCode).toBe(0);
    expect(typeof asObject(parseJson(res.stdout)).id).toBe("string");

    const req = mock.requests[0];
    expect(req?.method).toBe("DELETE");
    expect(req?.path).toBe("/users/me/goals/readbook/datapoints/abc123.json");
  });
});
